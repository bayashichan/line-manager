#!/usr/bin/env node
/**
 * Supabase Storage に残っている既存アセットを Cloudflare R2 へ移し、
 * DBに保存済みの公開URLを R2 のURLへ書き換える。
 *
 * 背景:
 *   LINEは配信のたびに画像・動画URLを受信者ぶん取得しにくる。
 *   Supabaseの公開バケットを配信元にしていると転送量(cached egress)が枠を超え、
 *   プロジェクトごと停止される（exceed_cached_egress_quota）。
 *   新規アップロードは既にR2へ向けたので、このスクリプトで過去分を移してから
 *   公開読み取りポリシーを外せば、Supabase側の転送量はゼロになる。
 *
 * 使い方:
 *   1) Supabaseプロジェクトが稼働している状態で実行する（制限中は実行できない）
 *   2) 環境変数を .env.local などで読み込ませる
 *        NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 *        R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME / R2_PUBLIC_DOMAIN
 *   3) まずドライラン:  node scripts/migrate-storage-to-r2.mjs --dry-run
 *      問題なければ:    node scripts/migrate-storage-to-r2.mjs
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

const DRY_RUN = process.argv.includes('--dry-run')

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const R2_PUBLIC_DOMAIN = process.env.R2_PUBLIC_DOMAIN?.replace(/\/$/, '')

const BUCKETS = ['line-assets', 'chat-uploads']

// URLを保持しているテーブル。JSONBは文字列化して一括置換する
const TEXT_COLUMNS = [{ table: 'rich_menus', column: 'image_url' }]
const JSON_COLUMNS = [
    { table: 'messages', column: 'content' },
    { table: 'step_messages', column: 'content' },
    { table: 'auto_replies', column: 'content' },
    { table: 'forms', column: 'completion_message' },
    { table: 'chat_messages', column: 'content' },
]

function requireEnv() {
    const missing = [
        ['NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL],
        ['SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE_KEY],
        ['R2_ACCOUNT_ID', process.env.R2_ACCOUNT_ID],
        ['R2_ACCESS_KEY_ID', process.env.R2_ACCESS_KEY_ID],
        ['R2_SECRET_ACCESS_KEY', process.env.R2_SECRET_ACCESS_KEY],
        ['R2_BUCKET_NAME', process.env.R2_BUCKET_NAME],
        ['R2_PUBLIC_DOMAIN', R2_PUBLIC_DOMAIN],
    ].filter(([, v]) => !v).map(([k]) => k)

    if (missing.length) {
        console.error(`環境変数が足りません: ${missing.join(', ')}`)
        process.exit(1)
    }
}

const supabase = () => createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const r2 = () => new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
})

/** バケット配下を再帰的に辿ってオブジェクトのパスを集める */
async function listAll(db, bucket, prefix = '') {
    const found = []
    let offset = 0
    const limit = 100

    for (;;) {
        const { data, error } = await db.storage.from(bucket).list(prefix, { limit, offset })
        if (error) throw new Error(`${bucket}/${prefix} の一覧取得に失敗: ${error.message}`)
        if (!data || data.length === 0) break

        for (const entry of data) {
            const path = prefix ? `${prefix}/${entry.name}` : entry.name
            // idを持つものが実ファイル。持たないものはフォルダ扱い
            if (entry.id) found.push(path)
            else found.push(...await listAll(db, bucket, path))
        }

        if (data.length < limit) break
        offset += limit
    }

    return found
}

async function copyObjects(db, client) {
    const copied = []

    for (const bucket of BUCKETS) {
        let paths
        try {
            paths = await listAll(db, bucket)
        } catch (e) {
            console.warn(`バケット ${bucket} をスキップ: ${e.message}`)
            continue
        }

        console.log(`\n[${bucket}] ${paths.length}件`)

        for (const path of paths) {
            const key = `${bucket}/${path}`
            const oldUrl = `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`
            const newUrl = `${R2_PUBLIC_DOMAIN}/${key}`

            if (DRY_RUN) {
                console.log(`  (dry-run) ${path}`)
                copied.push({ oldUrl, newUrl })
                continue
            }

            const { data, error } = await db.storage.from(bucket).download(path)
            if (error) {
                console.warn(`  ダウンロード失敗 ${path}: ${error.message}`)
                continue
            }

            const body = new Uint8Array(await data.arrayBuffer())
            await client.send(new PutObjectCommand({
                Bucket: process.env.R2_BUCKET_NAME,
                Key: key,
                Body: body,
                ContentType: data.type || 'application/octet-stream',
            }))

            console.log(`  移行 ${path}`)
            copied.push({ oldUrl, newUrl })
        }
    }

    return copied
}

/** 保存済みURLを置換する。バケット単位のプレフィックス置換なので取りこぼしが出ない */
function rewrite(text) {
    let out = text
    for (const bucket of BUCKETS) {
        out = out.split(`${SUPABASE_URL}/storage/v1/object/public/${bucket}/`)
            .join(`${R2_PUBLIC_DOMAIN}/${bucket}/`)
    }
    return out
}

async function rewriteDatabase(db) {
    for (const { table, column } of TEXT_COLUMNS) {
        const { data, error } = await db.from(table).select(`id, ${column}`)
        if (error) {
            console.warn(`\n[${table}] 読み取り失敗: ${error.message}`)
            continue
        }

        let changed = 0
        for (const row of data || []) {
            const current = row[column]
            if (typeof current !== 'string') continue
            const next = rewrite(current)
            if (next === current) continue

            changed++
            if (DRY_RUN) continue
            const { error: upErr } = await db.from(table).update({ [column]: next }).eq('id', row.id)
            if (upErr) console.warn(`  ${table}/${row.id} の更新失敗: ${upErr.message}`)
        }
        console.log(`\n[${table}.${column}] 書き換え ${changed}件${DRY_RUN ? '（dry-run）' : ''}`)
    }

    for (const { table, column } of JSON_COLUMNS) {
        const { data, error } = await db.from(table).select(`id, ${column}`)
        if (error) {
            console.warn(`\n[${table}] 読み取り失敗: ${error.message}`)
            continue
        }

        let changed = 0
        for (const row of data || []) {
            const current = JSON.stringify(row[column])
            if (!current) continue
            const next = rewrite(current)
            if (next === current) continue

            changed++
            if (DRY_RUN) continue
            const { error: upErr } = await db.from(table).update({ [column]: JSON.parse(next) }).eq('id', row.id)
            if (upErr) console.warn(`  ${table}/${row.id} の更新失敗: ${upErr.message}`)
        }
        console.log(`\n[${table}.${column}] 書き換え ${changed}件${DRY_RUN ? '（dry-run）' : ''}`)
    }
}

async function main() {
    requireEnv()

    if (DRY_RUN) console.log('=== ドライラン（書き込みは行いません） ===')

    const db = supabase()
    const client = r2()

    const copied = await copyObjects(db, client)
    console.log(`\n計 ${copied.length} 件のオブジェクトを対象にしました`)

    await rewriteDatabase(db)

    console.log(`\n完了。${DRY_RUN ? 'ドライランなので変更はありません。' : 'ダッシュボードで画像が表示されることを確認してください。'}`)
    console.log('確認できたら supabase/migrations/20260921000000_revoke_public_storage_read.sql を適用して公開読み取りを閉じてください。')
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
