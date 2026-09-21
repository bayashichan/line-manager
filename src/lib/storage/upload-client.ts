'use client'

import imageCompression from 'browser-image-compression'

/**
 * ブラウザから Cloudflare R2 へ直接アップロードする共通処理。
 *
 * 画像・動画は LINE 側が受信者ごとに取得しにくるため、配信元は転送量無料の R2 に統一する。
 * （Supabase Storage の公開URLを使うと cached egress の枠を超えてプロジェクトが停止する）
 */

export type UploadOptions = {
    /** R2のキー先頭に付ける用途名。例: 'messages' | 'steps' | 'auto-replies' */
    prefix?: string
    /** 画像を圧縮してからアップロードするか（リッチメニューなど原寸が必要な画像はfalse） */
    compress?: boolean
}

/**
 * LINEのメッセージ画像向けの圧縮設定。
 * LINEはトーク画面で最大1040px程度までしか表示せず、previewImageUrlには1MBの上限がある。
 * 1440px / 1MB に収めておけば見た目を保ったまま転送量を大きく減らせる。
 */
const LINE_IMAGE_COMPRESSION = {
    maxSizeMB: 1,
    maxWidthOrHeight: 1440,
    useWebWorker: true,
    fileType: 'image/jpeg',
}

async function compressImage(file: File): Promise<File> {
    try {
        const compressed = await imageCompression(file, LINE_IMAGE_COMPRESSION)
        const name = file.name.replace(/\.[^.]+$/, '') + '.jpg'
        return new File([compressed], name, { type: 'image/jpeg' })
    } catch (e) {
        // 圧縮に失敗しても配信自体は続けられるよう、元ファイルにフォールバックする
        console.warn('画像の圧縮に失敗したため元ファイルをアップロードします', e)
        return file
    }
}

export async function uploadToR2(
    file: File,
    channelId: string,
    options: UploadOptions = {}
): Promise<string> {
    const { prefix, compress = false } = options

    const target = compress && file.type.startsWith('image/') ? await compressImage(file) : file

    // 1. 署名付きURLを取得
    const res = await fetch('/api/upload/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            filename: target.name,
            contentType: target.type,
            channelId,
            prefix,
        }),
    })

    if (!res.ok) {
        const detail = await res.json().catch(() => null)
        throw new Error(detail?.error || 'アップロードURLの取得に失敗しました')
    }

    const { uploadUrl, publicUrl } = await res.json()

    // 2. R2へ直接アップロード
    const uploadRes = await fetch(uploadUrl, {
        method: 'PUT',
        body: target,
        headers: { 'Content-Type': target.type },
    })

    if (!uploadRes.ok) {
        throw new Error('ファイルのアップロードに失敗しました')
    }

    return publicUrl
}
