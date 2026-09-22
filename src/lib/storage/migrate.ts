import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildR2PublicUrl, createR2Client } from './r2'

/**
 * Supabase Storage に残っている既存アセットを R2 へ移し、
 * DBに保存済みの公開URLを R2 のURLへ書き換えるための処理。
 *
 * 新規アップロードは既にR2へ向けてあるので、ここは過去分の後始末。
 * これを終えてから公開読み取りポリシーを閉じると、Supabase側の転送量がゼロになる。
 */

/** 過去にアップロード先として使っていたバケット */
export const LEGACY_BUCKETS = ['line-assets', 'chat-uploads'] as const

/** URLを保持しているテーブル。JSONBは文字列化して一括置換する */
const TEXT_COLUMNS = [{ table: 'rich_menus', column: 'image_url' }] as const
const JSON_COLUMNS = [
    { table: 'messages', column: 'content' },
    { table: 'step_messages', column: 'content' },
    { table: 'auto_replies', column: 'content' },
    { table: 'forms', column: 'completion_message' },
    { table: 'chat_messages', column: 'content' },
] as const

type Db = SupabaseClient

function supabasePublicPrefix(bucket: string): string {
    const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '')
    return `${base}/storage/v1/object/public/${bucket}/`
}

/** バケット配下を再帰的に辿ってオブジェクトのパスを集める */
async function listAll(db: Db, bucket: string, prefix = ''): Promise<string[]> {
    const found: string[] = []
    let offset = 0
    const pageSize = 100

    for (;;) {
        const { data, error } = await db.storage.from(bucket).list(prefix, { limit: pageSize, offset })
        if (error) throw new Error(`${bucket}/${prefix} の一覧取得に失敗: ${error.message}`)
        if (!data || data.length === 0) break

        for (const entry of data) {
            const path = prefix ? `${prefix}/${entry.name}` : entry.name
            // idを持つものが実ファイル。持たないものはフォルダ扱い
            if (entry.id) found.push(path)
            else found.push(...(await listAll(db, bucket, path)))
        }

        if (data.length < pageSize) break
        offset += pageSize
    }

    return found
}

async function existsInR2(key: string): Promise<boolean> {
    try {
        await createR2Client().send(
            new HeadObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key })
        )
        return true
    } catch {
        return false
    }
}

export type CopyResult = {
    total: number
    copied: number
    alreadyCopied: number
    failed: string[]
    remaining: number
}

/**
 * Supabase Storage のオブジェクトを R2 へ複製する。
 * コピー済みのものは飛ばすので、remaining が 0 になるまで繰り返し呼べば完了する。
 */
export async function copyObjects(db: Db, limit: number, dryRun: boolean): Promise<CopyResult> {
    const client = createR2Client()
    const result: CopyResult = { total: 0, copied: 0, alreadyCopied: 0, failed: [], remaining: 0 }
    const pending: { bucket: string; path: string }[] = []

    for (const bucket of LEGACY_BUCKETS) {
        let paths: string[]
        try {
            paths = await listAll(db, bucket)
        } catch {
            // バケットが存在しない環境もあるので、その場合は黙って飛ばす
            continue
        }

        result.total += paths.length
        for (const path of paths) pending.push({ bucket, path })
    }

    for (const { bucket, path } of pending) {
        const key = `${bucket}/${path}`

        if (await existsInR2(key)) {
            result.alreadyCopied++
            continue
        }

        if (result.copied >= limit) {
            result.remaining++
            continue
        }

        if (dryRun) {
            result.copied++
            continue
        }

        const { data, error } = await db.storage.from(bucket).download(path)
        if (error || !data) {
            result.failed.push(`${key}: ${error?.message ?? 'ダウンロード失敗'}`)
            continue
        }

        try {
            await client.send(
                new PutObjectCommand({
                    Bucket: process.env.R2_BUCKET_NAME,
                    Key: key,
                    Body: new Uint8Array(await data.arrayBuffer()),
                    ContentType: data.type || 'application/octet-stream',
                })
            )
            result.copied++
        } catch (e) {
            result.failed.push(`${key}: ${e instanceof Error ? e.message : 'アップロード失敗'}`)
        }
    }

    return result
}

/** 保存済みURLを置換する。バケット単位のプレフィックス置換なので取りこぼしが出ない */
export function rewriteUrls(text: string): string {
    let out = text
    for (const bucket of LEGACY_BUCKETS) {
        out = out.split(supabasePublicPrefix(bucket)).join(buildR2PublicUrl(`${bucket}/`))
    }
    return out
}

/** PostgRESTの既定上限(1000件)に当たらないよう、id順にページングして全件読む */
async function* readAll(db: Db, table: string, column: string) {
    const pageSize = 500
    let from = 0

    for (;;) {
        const { data, error } = await db
            .from(table)
            .select(`id, ${column}`)
            .order('id')
            .range(from, from + pageSize - 1)

        if (error) throw new Error(error.message)
        if (!data || data.length === 0) return

        // selectのカラム名を動的に組み立てているため型推論が効かない
        yield* data as unknown as Record<string, unknown>[]

        if (data.length < pageSize) return
        from += pageSize
    }
}

async function rewriteColumn(
    db: Db,
    table: string,
    column: string,
    isJson: boolean,
    dryRun: boolean
): Promise<number | string> {
    let changed = 0

    try {
        for await (const row of readAll(db, table, column)) {
            const raw = row[column]
            const current = isJson ? JSON.stringify(raw) : raw
            if (typeof current !== 'string') continue

            const next = rewriteUrls(current)
            if (next === current) continue

            changed++
            if (dryRun) continue

            const value = isJson ? JSON.parse(next) : next
            const { error } = await db.from(table).update({ [column]: value }).eq('id', row.id as string)
            if (error) return `${table}.${column} の更新に失敗: ${error.message}`
        }
    } catch (e) {
        return `${table}.${column} の読み取りに失敗: ${e instanceof Error ? e.message : '不明なエラー'}`
    }

    return changed
}

export async function rewriteDatabase(db: Db, dryRun: boolean): Promise<Record<string, number | string>> {
    const report: Record<string, number | string> = {}

    for (const { table, column } of TEXT_COLUMNS) {
        report[`${table}.${column}`] = await rewriteColumn(db, table, column, false, dryRun)
    }
    for (const { table, column } of JSON_COLUMNS) {
        report[`${table}.${column}`] = await rewriteColumn(db, table, column, true, dryRun)
    }

    return report
}

/**
 * Supabase Storage のバケットを非公開にして、CDN経由の配信を止める。
 * 既存アセットの移行と表示確認を終えたあとに実行すること。
 *
 * public=false にすると /object/public/... のパスが使えなくなるので、
 * これだけで転送量(cached egress)は発生しなくなる。
 * storage.objects に残る公開読み取りポリシーの削除は
 * supabase/migrations/20260921000000_revoke_public_storage_read.sql を参照。
 */
export async function lockdownPublicRead(db: Db): Promise<Record<string, string>> {
    const done: Record<string, string> = {}

    for (const bucket of LEGACY_BUCKETS) {
        const { error } = await db.storage.updateBucket(bucket, { public: false })
        done[bucket] = error ? `失敗: ${error.message}` : '非公開にしました'
    }

    return done
}
