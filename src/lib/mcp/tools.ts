/**
 * AIエージェント（Claude など）から呼べる操作（MCP ツール）。
 *
 * 主な用途は「話し言葉で指示してステップ配信を作ってもらう」こと。
 * 参考: L Harness の @line-harness/mcp-server（create_scenario / manage_scenarios など）。
 *
 * 安全のための約束ごと:
 * - 操作できるのは、アクセストークンの持ち主が channel_members に登録されているチャンネルだけ
 *   （DB はサービスロールで触るので、ここで必ず所属を確認する）
 * - AIが作成したシナリオはオフ（is_active = false）で保存する。配信開始は明示的な操作が必要
 * - 送信を伴う操作はテスト送信（1人宛て）だけ。一斉配信のツールは用意しない
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server'
import { LineClient, LineContentError, buildLineMessages, replaceNamePlaceholder, toErrorMessage } from '@/lib/line'
import { calculateNextSendAt } from '@/lib/utils'
import {
    MAX_DAYS_AFTER,
    MAX_MESSAGES_PER_STEP,
    MAX_STEPS,
    MAX_TEXT_LENGTH,
    StepInputError,
    buildStepRows,
    compareStepTiming,
    describeStepTiming,
    type StepInput,
} from './step-scenario'

export type McpContext = {
    userId: string
    clientId: string
    baseUrl: string
}

type MemberChannel = { id: string; name: string; role: string }

type StepMessageRecord = {
    id: string
    scenario_id: string
    step_order: number
    delay_minutes: number
    send_hour: number | null
    send_minute: number | null
    content: unknown
}

/** 利用者に見せてよいエラー。これ以外の例外は詳細を伏せて返す */
class ToolError extends Error {}

const SERVER_INSTRUCTIONS = `
LINE Manager（LINE公式アカウントの管理ツール）を操作するためのツールです。主にステップ配信の作成・編集に使います。

## ステップ配信の考え方
- シナリオ = 開始条件 + 複数のステップ
  - 開始条件: follow（友だち追加されたとき） / tag_assigned（指定タグが付いたとき）
- 各ステップのタイミングは「開始日から N日後（days_after）」と「送信時刻 send_time（日本時間 HH:MM）」で決まる
  - days_after=0 かつ send_time なし → 開始直後に即時送信
  - days_after=0 かつ send_time あり → 当日のその時刻（過ぎていれば翌日）
  - send_time を省略した N日後 → 開始時刻からちょうど N×24時間後
- 1ステップに最大${MAX_MESSAGES_PER_STEP}メッセージ（テキスト・画像・動画）。テキストは${MAX_TEXT_LENGTH}文字まで。画像・動画は https のURL
- テキスト中の {name} は友だちの表示名に置き換わる（取得できないときは「友だち」）

## 進め方
1. まず list_channels / list_step_scenarios / list_tags で現状を把握する
2. 利用者の目的・ターゲット・トーンを踏まえて文面を考え、作成前に構成（各ステップのタイミングと文面の要約）を示して確認をとる
3. create_step_scenario はオフ（下書き）で保存される。作成後は get_step_scenario の内容をもとに、配信スケジュールと全文を利用者に見せる
4. 利用者が希望すれば send_test_message で本人の LINE にテスト送信する（送信枠を1通消費する）
5. 配信を始める（set_step_scenario_active で is_active=true）のは、利用者が明確に「オンにして」「配信開始して」と指示したときだけ

## 注意
- 友だち追加トリガーは、オンにした後に友だち追加した人から始まる。既存の友だちには送られない
- 送信は LINE のプッシュメッセージなので、配信数ぶん月の送信枠を消費する
- 削除（delete_step_scenario）は取り消せない。利用者の明示的な指示があるときだけ使う
`.trim()

export function createMcpServer(ctx: McpContext): McpServer {
    const server = new McpServer(
        { name: 'line-manager', version: '1.0.0' },
        { instructions: SERVER_INSTRUCTIONS }
    )
    const supabase = createAdminClient()
    let channelsCache: MemberChannel[] | null = null

    const memberChannels = async (): Promise<MemberChannel[]> => {
        if (channelsCache) return channelsCache
        const { data, error } = await supabase
            .from('channel_members')
            .select('role, channels(id, name)')
            .eq('profile_id', ctx.userId)
        if (error) throw new Error(`チャンネルの取得に失敗しました: ${error.message}`)
        type Row = { role: string; channels: { id: string; name: string } | { id: string; name: string }[] | null }
        channelsCache = ((data ?? []) as Row[]).flatMap(row => {
            const channel = Array.isArray(row.channels) ? row.channels[0] : row.channels
            return channel ? [{ id: channel.id, name: channel.name, role: row.role }] : []
        })
        return channelsCache
    }

    const resolveChannel = async (channelId?: string): Promise<MemberChannel> => {
        const channels = await memberChannels()
        if (channelId) {
            const found = channels.find(c => c.id === channelId)
            if (!found) throw new ToolError('指定したチャンネルが見つからないか、操作する権限がありません。list_channels で確認してください')
            return found
        }
        if (channels.length === 1) return channels[0]
        if (channels.length === 0) throw new ToolError('参加しているLINE公式アカウントがありません')
        throw new ToolError(
            `LINE公式アカウントが複数あります。channel_id を指定してください: ${channels.map(c => `${c.name}（${c.id}）`).join(' / ')}`
        )
    }

    const loadScenario = async (scenarioId: string) => {
        const { data: scenario } = await supabase
            .from('step_scenarios')
            .select('id, channel_id, name, trigger_type, trigger_tag_id, is_active, created_at, updated_at')
            .eq('id', scenarioId)
            .maybeSingle()
        const channels = await memberChannels()
        if (!scenario || !channels.some(c => c.id === scenario.channel_id)) {
            throw new ToolError('シナリオが見つからないか、操作する権限がありません。list_step_scenarios で確認してください')
        }
        return scenario
    }

    const loadSteps = async (scenarioId: string): Promise<StepMessageRecord[]> => {
        const { data, error } = await supabase
            .from('step_messages')
            .select('id, scenario_id, step_order, delay_minutes, send_hour, send_minute, content')
            .eq('scenario_id', scenarioId)
        if (error) throw new Error(`ステップの取得に失敗しました: ${error.message}`)
        return ((data ?? []) as StepMessageRecord[]).sort(compareStepTiming)
    }

    const assertTagInChannel = async (tagId: string, channelId: string) => {
        const { data: tag } = await supabase
            .from('tags')
            .select('id')
            .eq('id', tagId)
            .eq('channel_id', channelId)
            .maybeSingle()
        if (!tag) throw new ToolError('指定したタグがこのアカウントにありません。list_tags で確認してください')
    }

    const logActivity = async (channelId: string, action: string, resourceId: string, details: object) => {
        const { error } = await supabase.from('activity_logs').insert({
            profile_id: ctx.userId,
            channel_id: channelId,
            action,
            resource_type: 'step_scenario',
            resource_id: resourceId,
            details: { ...details, via: 'mcp', client_id: ctx.clientId },
        })
        if (error) console.error('MCP 操作ログの保存エラー:', error)
    }

    const describeScenario = async (scenarioId: string) => {
        const scenario = await loadScenario(scenarioId)
        const steps = await loadSteps(scenarioId)
        let triggerTagName: string | null = null
        if (scenario.trigger_tag_id) {
            const { data: tag } = await supabase.from('tags').select('name').eq('id', scenario.trigger_tag_id).maybeSingle()
            triggerTagName = tag?.name ?? null
        }
        const now = new Date()
        return {
            id: scenario.id,
            channel_id: scenario.channel_id,
            name: scenario.name,
            trigger: scenario.trigger_type === 'follow'
                ? '友だち追加'
                : `タグ付与（${triggerTagName ?? '削除されたタグ'}）`,
            trigger_type: scenario.trigger_type,
            trigger_tag_id: scenario.trigger_tag_id,
            is_active: scenario.is_active,
            status: scenario.is_active ? '配信中（オン）' : '停止中（オフ）',
            steps: steps.map((step, index) => ({
                step_number: index + 1,
                timing: describeStepTiming(step.delay_minutes, step.send_hour, step.send_minute),
                days_after: Math.floor(step.delay_minutes / 1440),
                send_time: step.send_hour === null ? null : `${String(step.send_hour).padStart(2, '0')}:${String(step.send_minute ?? 0).padStart(2, '0')}`,
                // 今この瞬間に開始した場合の送信予定（日本時間）
                example_send_at_if_started_now: formatJst(
                    calculateNextSendAt(now, step.delay_minutes, step.send_hour, step.send_minute ?? 0)
                ),
                messages: step.content,
            })),
            dashboard_url: `${ctx.baseUrl}/dashboard/step`,
        }
    }

    // -------------------------------------------------------------------------
    // 参照系
    // -------------------------------------------------------------------------

    server.registerTool(
        'list_channels',
        {
            title: 'LINE公式アカウント一覧',
            description: '操作できるLINE公式アカウント（チャンネル）の一覧と、友だち数・ステップ配信数を返します。',
            inputSchema: {},
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        () => run(async () => {
            const channels = await memberChannels()
            const result = await Promise.all(channels.map(async channel => {
                const [{ count: friendCount }, { count: scenarioCount }] = await Promise.all([
                    supabase.from('line_users').select('id', { count: 'exact', head: true })
                        .eq('channel_id', channel.id).eq('is_blocked', false),
                    supabase.from('step_scenarios').select('id', { count: 'exact', head: true })
                        .eq('channel_id', channel.id),
                ])
                return {
                    id: channel.id,
                    name: channel.name,
                    role: channel.role,
                    friend_count: friendCount ?? 0,
                    step_scenario_count: scenarioCount ?? 0,
                }
            }))
            return { channels: result }
        })
    )

    server.registerTool(
        'list_tags',
        {
            title: 'タグ一覧',
            description: 'タグの一覧を返します。タグ付与をきっかけに始まるステップ配信を作るときに、タグのIDを調べるのに使います。',
            inputSchema: {
                channel_id: z.string().optional().describe('対象アカウントのID。1つしかない場合は省略可'),
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        ({ channel_id }) => run(async () => {
            const channel = await resolveChannel(channel_id)
            const { data, error } = await supabase
                .from('tags')
                .select('id, name, color')
                .eq('channel_id', channel.id)
                .order('name')
            if (error) throw new Error(error.message)
            return { channel: channel.name, tags: data ?? [] }
        })
    )

    server.registerTool(
        'list_step_scenarios',
        {
            title: 'ステップ配信一覧',
            description: 'ステップ配信（シナリオ）の一覧を返します。開始条件、オン/オフ、ステップ数、配信中の人数が分かります。',
            inputSchema: {
                channel_id: z.string().optional().describe('対象アカウントのID。1つしかない場合は省略可'),
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        ({ channel_id }) => run(async () => {
            const channel = await resolveChannel(channel_id)
            const [{ data: scenarios, error }, { data: tags }] = await Promise.all([
                supabase
                    .from('step_scenarios')
                    .select('id, name, trigger_type, trigger_tag_id, is_active, created_at, updated_at, step_messages(id)')
                    .eq('channel_id', channel.id)
                    .order('created_at'),
                supabase.from('tags').select('id, name').eq('channel_id', channel.id),
            ])
            if (error) throw new Error(error.message)
            const tagName = new Map((tags ?? []).map(t => [t.id, t.name]))

            type ScenarioRow = {
                id: string
                name: string
                trigger_type: string
                trigger_tag_id: string | null
                is_active: boolean
                updated_at: string
                step_messages: { id: string }[] | null
            }
            const result = await Promise.all(((scenarios ?? []) as ScenarioRow[]).map(async s => {
                const { count } = await supabase
                    .from('step_executions')
                    .select('id', { count: 'exact', head: true })
                    .eq('scenario_id', s.id)
                    .eq('status', 'active')
                return {
                    id: s.id,
                    name: s.name,
                    trigger: s.trigger_type === 'follow'
                        ? '友だち追加'
                        : `タグ付与（${(s.trigger_tag_id && tagName.get(s.trigger_tag_id)) || '削除されたタグ'}）`,
                    is_active: s.is_active,
                    step_count: Array.isArray(s.step_messages) ? s.step_messages.length : 0,
                    active_recipients: count ?? 0,
                    updated_at: s.updated_at,
                }
            }))
            return { channel: channel.name, scenarios: result }
        })
    )

    server.registerTool(
        'get_step_scenario',
        {
            title: 'ステップ配信の詳細',
            description: 'ステップ配信（シナリオ）の全ステップのタイミングと文面を返します。作成・編集後に内容を利用者へ見せるときにも使います。',
            inputSchema: {
                scenario_id: z.string().describe('シナリオID'),
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        ({ scenario_id }) => run(() => describeScenario(scenario_id))
    )

    // -------------------------------------------------------------------------
    // 作成・編集
    // -------------------------------------------------------------------------

    const messageSchema = z.discriminatedUnion('type', [
        z.object({
            type: z.literal('text'),
            text: z.string().min(1).max(MAX_TEXT_LENGTH).describe('本文。{name} は友だちの表示名に置き換わる'),
        }),
        z.object({
            type: z.literal('image'),
            image_url: z.string().url().describe('画像のURL（https、JPEG/PNG）'),
        }),
        z.object({
            type: z.literal('video'),
            video_url: z.string().url().describe('動画のURL（https、mp4）'),
            preview_image_url: z.string().url().describe('動画のサムネイル画像URL（https）'),
        }),
    ])

    const stepSchema = z.object({
        days_after: z.number().int().min(0).max(MAX_DAYS_AFTER)
            .describe('開始日（友だち追加日・タグ付与日）から何日後か。0 は当日'),
        send_time: z.string().nullable().optional()
            .describe('送信時刻（日本時間 "HH:MM"）。省略すると開始時刻からちょうど N日後（0日なら即時）'),
        messages: z.array(messageSchema).min(1).max(MAX_MESSAGES_PER_STEP)
            .describe(`このステップで送るメッセージ（最大${MAX_MESSAGES_PER_STEP}個）`),
    })

    const triggerTypeSchema = z.enum(['follow', 'tag_assigned'])
        .describe('開始条件。follow: 友だち追加されたとき / tag_assigned: 指定タグが付いたとき')

    server.registerTool(
        'create_step_scenario',
        {
            title: 'ステップ配信を作成',
            description:
                'ステップ配信（シナリオ）を新しく作ります。安全のためオフ（下書き）で保存され、この時点では誰にも送信されません。' +
                '作成前に構成を利用者に確認し、作成後は get_step_scenario の結果を見せてください。',
            inputSchema: {
                channel_id: z.string().optional().describe('対象アカウントのID。1つしかない場合は省略可'),
                name: z.string().min(1).max(100).describe('シナリオ名（管理画面に表示される）'),
                trigger_type: triggerTypeSchema,
                trigger_tag_id: z.string().optional().describe('trigger_type が tag_assigned のとき必須。list_tags で調べたタグID'),
                steps: z.array(stepSchema).min(1).max(MAX_STEPS).describe('ステップの一覧。配信日時の早い順に自動で並べ替える'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        },
        ({ channel_id, name, trigger_type, trigger_tag_id, steps }) => run(async () => {
            const channel = await resolveChannel(channel_id)
            if (trigger_type === 'tag_assigned') {
                if (!trigger_tag_id) throw new ToolError('tag_assigned のときは trigger_tag_id を指定してください')
                await assertTagInChannel(trigger_tag_id, channel.id)
            }
            const rows = buildStepRows(steps as StepInput[])
            validateLineContent(rows.map(r => r.content))

            const { data: scenario, error } = await supabase
                .from('step_scenarios')
                .insert({
                    channel_id: channel.id,
                    name,
                    trigger_type,
                    trigger_tag_id: trigger_type === 'tag_assigned' ? trigger_tag_id : null,
                    is_active: false,
                })
                .select('id')
                .single()
            if (error || !scenario) throw new Error(`シナリオの保存に失敗しました: ${error?.message}`)

            const { error: stepError } = await supabase
                .from('step_messages')
                .insert(rows.map(row => ({ scenario_id: scenario.id, ...row })))
            if (stepError) {
                await supabase.from('step_scenarios').delete().eq('id', scenario.id)
                throw new Error(`ステップの保存に失敗しました: ${stepError.message}`)
            }

            await logActivity(channel.id, 'step_scenario.create', scenario.id, { name, step_count: rows.length })

            return {
                message: 'オフ（下書き）の状態で保存しました。まだ誰にも送信されません。',
                scenario: await describeScenario(scenario.id),
            }
        })
    )

    server.registerTool(
        'update_step_scenario',
        {
            title: 'ステップ配信を編集',
            description:
                'ステップ配信（シナリオ）の名前・開始条件・ステップを変更します。steps を指定した場合は全ステップを置き換えます' +
                '（一部だけ直すときも、get_step_scenario で取得した全ステップを渡してください）。' +
                'オンのシナリオを編集すると、配信途中の人にも次のステップから新しい内容が届きます。',
            inputSchema: {
                scenario_id: z.string().describe('シナリオID'),
                name: z.string().min(1).max(100).optional().describe('新しいシナリオ名'),
                trigger_type: triggerTypeSchema.optional(),
                trigger_tag_id: z.string().optional().describe('trigger_type が tag_assigned のときのタグID'),
                steps: z.array(stepSchema).min(1).max(MAX_STEPS).optional().describe('置き換え後の全ステップ'),
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        },
        ({ scenario_id, name, trigger_type, trigger_tag_id, steps }) => run(async () => {
            const scenario = await loadScenario(scenario_id)

            const nextTrigger = trigger_type ?? scenario.trigger_type
            const nextTagId = nextTrigger === 'tag_assigned' ? (trigger_tag_id ?? scenario.trigger_tag_id) : null
            if (nextTrigger === 'tag_assigned') {
                if (!nextTagId) throw new ToolError('tag_assigned のときは trigger_tag_id を指定してください')
                await assertTagInChannel(nextTagId, scenario.channel_id)
            }

            const rows = steps ? buildStepRows(steps as StepInput[]) : null
            if (rows) validateLineContent(rows.map(r => r.content))

            const { error } = await supabase
                .from('step_scenarios')
                .update({
                    ...(name !== undefined ? { name } : {}),
                    trigger_type: nextTrigger,
                    trigger_tag_id: nextTagId,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', scenario.id)
            if (error) throw new Error(`シナリオの更新に失敗しました: ${error.message}`)

            if (rows) {
                // 管理画面の保存と同じく、全ステップを消してから入れ直す。
                // 入れ直しに失敗したら元のステップに戻す。
                const previous = await loadSteps(scenario.id)
                const { error: deleteError } = await supabase.from('step_messages').delete().eq('scenario_id', scenario.id)
                if (deleteError) throw new Error(`ステップの更新に失敗しました: ${deleteError.message}`)

                const { error: insertError } = await supabase
                    .from('step_messages')
                    .insert(rows.map(row => ({ scenario_id: scenario.id, ...row })))
                if (insertError) {
                    if (previous.length > 0) {
                        await supabase.from('step_messages').insert(previous)
                    }
                    throw new Error(`ステップの保存に失敗したため、元の内容に戻しました: ${insertError.message}`)
                }
            }

            await logActivity(scenario.channel_id, 'step_scenario.update', scenario.id, {
                name: name ?? scenario.name,
                steps_replaced: Boolean(rows),
            })

            return { message: '更新しました。', scenario: await describeScenario(scenario.id) }
        })
    )

    server.registerTool(
        'set_step_scenario_active',
        {
            title: 'ステップ配信のオン/オフ',
            description:
                'ステップ配信をオン（配信開始）またはオフ（停止）にします。' +
                'オンにすると、これ以降に開始条件を満たした友だちへ実際に送信されます。利用者が明確に指示したときだけ使ってください。',
            inputSchema: {
                scenario_id: z.string().describe('シナリオID'),
                is_active: z.boolean().describe('true: オン（配信開始） / false: オフ（停止）'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        },
        ({ scenario_id, is_active }) => run(async () => {
            const scenario = await loadScenario(scenario_id)
            if (is_active) {
                const steps = await loadSteps(scenario.id)
                if (steps.length === 0) throw new ToolError('ステップが1つもないためオンにできません')
                validateLineContent(steps.map(s => s.content))
            }

            const { error } = await supabase
                .from('step_scenarios')
                .update({ is_active, updated_at: new Date().toISOString() })
                .eq('id', scenario.id)
            if (error) throw new Error(`更新に失敗しました: ${error.message}`)

            await logActivity(scenario.channel_id, is_active ? 'step_scenario.activate' : 'step_scenario.deactivate', scenario.id, {
                name: scenario.name,
            })

            return {
                message: is_active
                    ? 'オンにしました。これ以降に開始条件を満たした友だちへ配信されます（既に友だちの人・既にタグが付いている人には送られません）。'
                    : 'オフにしました。新しく開始される人はいなくなります。',
                scenario_id: scenario.id,
                is_active,
            }
        })
    )

    server.registerTool(
        'delete_step_scenario',
        {
            title: 'ステップ配信を削除',
            description: 'ステップ配信（シナリオ）を削除します。配信途中の人への送信も止まり、元に戻せません。利用者が明確に指示したときだけ使ってください。',
            inputSchema: {
                scenario_id: z.string().describe('シナリオID'),
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        },
        ({ scenario_id }) => run(async () => {
            const scenario = await loadScenario(scenario_id)
            const { error } = await supabase.from('step_scenarios').delete().eq('id', scenario.id)
            if (error) throw new Error(`削除に失敗しました: ${error.message}`)
            await logActivity(scenario.channel_id, 'step_scenario.delete', scenario.id, { name: scenario.name })
            return { message: `「${scenario.name}」を削除しました。`, scenario_id: scenario.id }
        })
    )

    // -------------------------------------------------------------------------
    // テスト送信
    // -------------------------------------------------------------------------

    server.registerTool(
        'search_friends',
        {
            title: '友だちを検索',
            description: '表示名または管理用ネームで友だちを検索します。テスト送信の宛先（利用者本人のLINE）を探すのに使います。',
            inputSchema: {
                channel_id: z.string().optional().describe('対象アカウントのID。1つしかない場合は省略可'),
                query: z.string().min(1).max(50).describe('名前の一部'),
                limit: z.number().int().min(1).max(20).optional().describe('最大件数（既定10）'),
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        ({ channel_id, query, limit }) => run(async () => {
            const channel = await resolveChannel(channel_id)
            // PostgREST の or 条件を壊す文字は除く
            const keyword = query.replace(/[%,()*\\]/g, '').trim()
            if (!keyword) throw new ToolError('検索する名前を指定してください')
            const { data, error } = await supabase
                .from('line_users')
                .select('id, display_name, internal_name, is_blocked, followed_at')
                .eq('channel_id', channel.id)
                .or(`display_name.ilike.%${keyword}%,internal_name.ilike.%${keyword}%`)
                .order('followed_at', { ascending: false })
                .limit(limit ?? 10)
            if (error) throw new Error(error.message)
            return { channel: channel.name, friends: data ?? [] }
        })
    )

    server.registerTool(
        'send_test_message',
        {
            title: 'ステップをテスト送信',
            description:
                'ステップ配信の1ステップを、指定した友だち1人にテスト送信します（オフのシナリオでも送れます）。' +
                '送信枠を1通消費します。宛先は利用者本人など、利用者が指定した相手に限ってください。',
            inputSchema: {
                scenario_id: z.string().describe('シナリオID'),
                step_number: z.number().int().min(1).describe('何番目のステップか（get_step_scenario の step_number）'),
                friend_id: z.string().describe('宛先の友だちID（search_friends の id）'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        ({ scenario_id, step_number, friend_id }) => run(async () => {
            const scenario = await loadScenario(scenario_id)
            const steps = await loadSteps(scenario.id)
            const step = steps[step_number - 1]
            if (!step) throw new ToolError(`ステップ${step_number}はありません（全${steps.length}ステップ）`)

            const { data: friend } = await supabase
                .from('line_users')
                .select('id, line_user_id, display_name, is_blocked')
                .eq('id', friend_id)
                .eq('channel_id', scenario.channel_id)
                .maybeSingle()
            if (!friend) throw new ToolError('宛先の友だちが見つかりません。search_friends で確認してください')
            if (friend.is_blocked) throw new ToolError('この友だちはブロック中のため送信できません')

            const { data: channel } = await supabase
                .from('channels')
                .select('channel_access_token')
                .eq('id', scenario.channel_id)
                .single()
            if (!channel) throw new Error('チャンネル情報を取得できませんでした')

            let messages: object[]
            try {
                messages = replaceNamePlaceholder(
                    buildLineMessages(step.content, { postbackData: 'action=custom&mid=TEST_SEND' }),
                    friend.display_name
                )
            } catch (err) {
                if (err instanceof LineContentError) throw new ToolError(`内容がLINEの仕様に合いません: ${err.message}`)
                throw err
            }

            try {
                await new LineClient(channel.channel_access_token).pushMessage(friend.line_user_id, messages)
            } catch (err) {
                throw new ToolError(`LINEへの送信に失敗しました: ${toErrorMessage(err, 500)}`)
            }

            return {
                message: `${friend.display_name ?? '友だち'} さんにステップ${step_number}をテスト送信しました。`,
                timing: describeStepTiming(step.delay_minutes, step.send_hour, step.send_minute),
            }
        })
    )

    return server
}

/** 送る前に LINE の仕様チェック（一斉配信・ステップ配信と同じ変換）を通しておく */
function validateLineContent(contents: unknown[]) {
    contents.forEach((content, index) => {
        try {
            buildLineMessages(content)
        } catch (err) {
            if (err instanceof LineContentError) {
                throw new ToolError(`ステップ${index + 1}: 内容がLINEの仕様に合いません: ${err.message}`)
            }
            throw err
        }
    })
}

function formatJst(iso: string): string {
    return new Date(iso).toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'short',
    })
}

/** ツールの処理を実行し、MCP の結果形式に包む */
async function run(fn: () => Promise<unknown>) {
    try {
        const result = await fn()
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    } catch (err) {
        const expected = err instanceof ToolError || err instanceof StepInputError
        if (!expected) console.error('MCP ツールエラー:', err)
        const message = err instanceof Error
            ? err.message
            : '処理中にエラーが発生しました。時間をおいて再度お試しください。'
        return { content: [{ type: 'text' as const, text: message }], isError: true }
    }
}
