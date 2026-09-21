import { NextRequest, NextResponse } from 'next/server'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createClient } from '@/lib/supabase/server'
import { buildR2PublicUrl, createR2Client, isR2Configured } from '@/lib/storage/r2'

// 用途ごとのプレフィックス。想定外の値でキー空間を汚さないよう許可制にする
const ALLOWED_PREFIXES = ['chats', 'messages', 'steps', 'auto-replies', 'forms', 'rich-menus']

export async function POST(request: NextRequest) {
    try {
        const body = await request.json()
        const { filename, contentType, channelId, prefix } = body

        if (!filename || !contentType || !channelId) {
            return NextResponse.json({ error: 'Missing parameters' }, { status: 400 })
        }

        if (!isR2Configured()) {
            return NextResponse.json(
                { error: 'ファイル配信用のR2が未設定です（R2_* の環境変数を確認してください）' },
                { status: 503 }
            )
        }

        const supabase = await createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // Generate a unique file path
        // Format: {prefix?}/{channelId}/{userId}/{timestamp}_{random}.{extension} (Use safe characters only)
        const timestamp = Date.now()
        const random = Math.random().toString(36).substring(7)
        const ext = filename.split('.').pop() || 'bin'
        const safeFilename = `${timestamp}_${random}.${ext}`
        const folder = ALLOWED_PREFIXES.includes(prefix) ? `${prefix}/` : ''
        const key = `${folder}${channelId}/${user.id}/${safeFilename}`

        // Create the PutObject command
        const command = new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key,
            ContentType: contentType,
        })

        // Generate the pre-signed URL (valid for 5 minutes)
        const signedUrl = await getSignedUrl(createR2Client(), command, { expiresIn: 300 })

        return NextResponse.json({
            uploadUrl: signedUrl,
            publicUrl: buildR2PublicUrl(key),
            key: key
        })

    } catch (error) {
        console.error('Error generating signed URL:', error)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}
