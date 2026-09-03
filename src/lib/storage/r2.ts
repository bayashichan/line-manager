import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

/**
 * Cloudflare R2 へのサーバー側アップロード。
 *
 * 管理画面からのアップロードは署名付きURL（/api/upload/url）を使うが、
 * Webhookで受け取った画像・動画のようにサーバー側に実体がある場合は
 * ここから直接PUTする。
 */

let cachedClient: S3Client | null = null

function getClient(): S3Client {
    if (!cachedClient) {
        cachedClient = new S3Client({
            region: 'auto',
            endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
            credentials: {
                accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
                secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
            },
        })
    }
    return cachedClient
}

/** R2の設定が揃っているか。未設定の環境ではメディア保存をスキップする */
export function isR2Configured(): boolean {
    return Boolean(
        process.env.R2_ACCOUNT_ID &&
        process.env.R2_ACCESS_KEY_ID &&
        process.env.R2_SECRET_ACCESS_KEY &&
        process.env.R2_BUCKET_NAME &&
        process.env.R2_PUBLIC_DOMAIN
    )
}

const EXTENSION_BY_TYPE: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'audio/x-m4a': 'm4a',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'application/pdf': 'pdf',
}

export function extensionForContentType(contentType: string, fallback = 'bin'): string {
    const normalized = contentType.split(';')[0].trim().toLowerCase()
    return EXTENSION_BY_TYPE[normalized] ?? fallback
}

export type UploadParams = {
    /** バケット内のキー。衝突しないよう呼び出し側でユニークにする */
    key: string
    body: Uint8Array | Buffer
    contentType: string
}

/**
 * R2へアップロードして公開URLを返す。
 * 未設定の場合は null を返す（呼び出し元で保存をあきらめる）。
 */
export async function uploadToR2({ key, body, contentType }: UploadParams): Promise<string | null> {
    if (!isR2Configured()) {
        console.warn('R2が未設定のためアップロードをスキップしました')
        return null
    }

    await getClient().send(
        new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key,
            Body: body,
            ContentType: contentType,
        })
    )

    const publicDomain = process.env.R2_PUBLIC_DOMAIN?.replace(/\/$/, '')
    return `${publicDomain}/${key}`
}
