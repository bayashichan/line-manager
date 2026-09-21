import { S3Client } from '@aws-sdk/client-s3'

/**
 * Cloudflare R2 の共通設定。
 *
 * LINE へ渡す画像・動画のURLは、配信のたびにLINE側から受信者数ぶん取得される。
 * Supabase Storage の公開バケットに置くと転送量（cached egress）が枠を食い潰し、
 * プロジェクトごと停止される。R2 は egress 無料なのでこちらを配信元にする。
 */

export const R2_PUBLIC_DOMAIN = process.env.R2_PUBLIC_DOMAIN?.replace(/\/$/, '') || ''

export function isR2Configured(): boolean {
    return Boolean(
        process.env.R2_ACCOUNT_ID &&
        process.env.R2_ACCESS_KEY_ID &&
        process.env.R2_SECRET_ACCESS_KEY &&
        process.env.R2_BUCKET_NAME &&
        R2_PUBLIC_DOMAIN
    )
}

export function createR2Client(): S3Client {
    return new S3Client({
        region: 'auto',
        endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
        },
    })
}

export function buildR2PublicUrl(key: string): string {
    return `${R2_PUBLIC_DOMAIN}/${key}`
}

/**
 * 衝突しないオブジェクトキーを作る。
 * 形式: {prefix}/{channelId}/{timestamp}_{random}.{ext}
 */
export function buildR2Key(prefix: string, channelId: string, filename: string): string {
    const timestamp = Date.now()
    const random = Math.random().toString(36).substring(2, 8)
    const ext = (filename.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin'
    return `${prefix}/${channelId}/${timestamp}_${random}.${ext}`
}

/**
 * サーバー側から R2 へ直接アップロードする。
 * 署名付きURLを経由できないAPIルート用。
 */
export async function uploadToR2Server(
    key: string,
    body: Uint8Array,
    contentType: string
): Promise<string> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3')

    await createR2Client().send(
        new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key,
            Body: body,
            ContentType: contentType,
        })
    )

    return buildR2PublicUrl(key)
}
