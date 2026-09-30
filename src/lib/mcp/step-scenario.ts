/**
 * AIエージェント（MCP）から受け取ったステップ配信の入力を、
 * 管理画面（dashboard/step）が保存するのと同じ形の step_messages 行へ変換する。
 *
 * 管理画面との対応:
 * - 「N日後 HH:MM」  → delay_minutes = N * 1440, send_hour = HH, send_minute = MM
 * - 「即時」（0日後・時刻なし） → delay_minutes = 0, send_hour = null
 * - テキスト / 画像 / 動画のブロック → content の各要素（buildContentFromBlocks と同じ形）
 *
 * 配信時刻の計算は calculateNextSendAt（src/lib/utils.ts）、配信は /api/cron/step-messages が行う。
 */

/** 1回の送信（プッシュ）に入れられるメッセージ数の上限（LINE仕様） */
export const MAX_MESSAGES_PER_STEP = 5
/** テキストメッセージの最大文字数（LINE仕様） */
export const MAX_TEXT_LENGTH = 5000
/** 1シナリオのステップ数の上限（誤操作で大量に作られないように） */
export const MAX_STEPS = 60
/** 何日後まで指定できるか */
export const MAX_DAYS_AFTER = 365

export type StepMessageInput =
    | { type: 'text'; text: string }
    | { type: 'image'; image_url: string }
    | { type: 'video'; video_url: string; preview_image_url: string }

export type StepInput = {
    /** 開始日（友だち追加日・タグ付与日）から何日後か。0 は当日 */
    days_after: number
    /** 送信時刻（日本時間の "HH:MM"）。省略すると開始時刻からちょうど N日後（0日なら即時） */
    send_time?: string | null
    messages: StepMessageInput[]
}

export type StepContentBlock =
    | { type: 'text'; text: string }
    | { type: 'image'; originalContentUrl: string; previewImageUrl: string }
    | { type: 'video'; originalContentUrl: string; previewImageUrl: string }

export type StepMessageRow = {
    step_order: number
    delay_minutes: number
    send_hour: number | null
    send_minute: number
    content: StepContentBlock[]
}

export class StepInputError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'StepInputError'
    }
}

/** "HH:MM"（日本時間）を時・分に分解する。空なら null（= 時刻指定なし） */
export function parseSendTime(value: string | null | undefined): { hour: number; minute: number } | null {
    if (value === null || value === undefined || value.trim() === '') return null
    const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim())
    if (!match) {
        throw new StepInputError(`送信時刻は "HH:MM"（例: "10:00"）で指定してください: ${value}`)
    }
    return { hour: Number(match[1]), minute: Number(match[2]) }
}

function assertHttpsUrl(value: string, label: string): string {
    let url: URL
    try {
        url = new URL(value)
    } catch {
        throw new StepInputError(`${label}のURLが不正です: ${value}`)
    }
    if (url.protocol !== 'https:') {
        throw new StepInputError(`${label}のURLは https で始まる必要があります（LINEの仕様）: ${value}`)
    }
    return value
}

export function toContentBlock(message: StepMessageInput): StepContentBlock {
    switch (message.type) {
        case 'text': {
            const text = message.text ?? ''
            if (!text.trim()) throw new StepInputError('空のテキストメッセージは送れません')
            if (text.length > MAX_TEXT_LENGTH) {
                throw new StepInputError(`テキストは${MAX_TEXT_LENGTH}文字以内にしてください（現在${text.length}文字）`)
            }
            return { type: 'text', text }
        }
        case 'image': {
            const url = assertHttpsUrl(message.image_url, '画像')
            return { type: 'image', originalContentUrl: url, previewImageUrl: url }
        }
        case 'video': {
            return {
                type: 'video',
                originalContentUrl: assertHttpsUrl(message.video_url, '動画'),
                previewImageUrl: assertHttpsUrl(message.preview_image_url, '動画のサムネイル画像'),
            }
        }
        default:
            throw new StepInputError('メッセージの種類は text / image / video のいずれかです')
    }
}

/**
 * 配信の早い順に並べるための比較関数。
 * /api/cron/step-messages が次のステップを決めるときと同じ順序にする
 * （日数 → 時（未指定は0扱い） → 分。同じなら入力順のまま）。
 */
export function compareStepTiming(
    a: { delay_minutes: number; send_hour: number | null; send_minute: number | null },
    b: { delay_minutes: number; send_hour: number | null; send_minute: number | null }
): number {
    if (a.delay_minutes !== b.delay_minutes) return a.delay_minutes - b.delay_minutes
    const aHour = a.send_hour ?? 0
    const bHour = b.send_hour ?? 0
    if (aHour !== bHour) return aHour - bHour
    return (a.send_minute ?? 0) - (b.send_minute ?? 0)
}

/** 入力されたステップを検証し、配信順に並べた step_messages 行（scenario_id 以外）にする */
export function buildStepRows(steps: StepInput[]): StepMessageRow[] {
    if (!Array.isArray(steps) || steps.length === 0) {
        throw new StepInputError('ステップを1つ以上指定してください')
    }
    if (steps.length > MAX_STEPS) {
        throw new StepInputError(`ステップは${MAX_STEPS}個までです`)
    }

    const rows = steps.map((step, index) => {
        const label = `ステップ${index + 1}`
        if (!Number.isInteger(step.days_after) || step.days_after < 0 || step.days_after > MAX_DAYS_AFTER) {
            throw new StepInputError(`${label}: days_after は 0〜${MAX_DAYS_AFTER} の整数で指定してください`)
        }
        if (!Array.isArray(step.messages) || step.messages.length === 0) {
            throw new StepInputError(`${label}: メッセージを1つ以上指定してください`)
        }
        if (step.messages.length > MAX_MESSAGES_PER_STEP) {
            throw new StepInputError(`${label}: 1ステップのメッセージは${MAX_MESSAGES_PER_STEP}個までです（LINEの仕様）`)
        }

        let time: { hour: number; minute: number } | null
        let content: StepContentBlock[]
        try {
            time = parseSendTime(step.send_time)
            content = step.messages.map(toContentBlock)
        } catch (err) {
            if (err instanceof StepInputError) throw new StepInputError(`${label}: ${err.message}`)
            throw err
        }

        return {
            delay_minutes: step.days_after * 1440,
            send_hour: time ? time.hour : null,
            send_minute: time ? time.minute : 0,
            content,
        }
    })

    return rows
        .map((row, index) => ({ row, index }))
        .sort((a, b) => compareStepTiming(a.row, b.row) || a.index - b.index)
        .map(({ row }, i) => ({ step_order: i + 1, ...row }))
}

/** 人が読むタイミング表記（例: "3日後 10:00" / "即時" / "当日 20:00"） */
export function describeStepTiming(delayMinutes: number, sendHour: number | null, sendMinute: number | null): string {
    const days = Math.floor(delayMinutes / 1440)
    if (sendHour === null || sendHour === undefined) {
        if (delayMinutes === 0) return '即時（開始直後）'
        if (delayMinutes % 1440 === 0) return `${days}日後（開始時刻から${days * 24}時間後）`
        return `開始から${delayMinutes}分後`
    }
    const time = `${sendHour}:${String(sendMinute ?? 0).padStart(2, '0')}`
    return days === 0 ? `当日 ${time}（過ぎていれば翌日）` : `${days}日後 ${time}`
}
