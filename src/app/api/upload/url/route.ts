import { NextRequest, NextResponse } from 'next/server'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createClient } from '@/lib/supabase/server'

// R2 Client Initialization
const R2 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    },
})

export async function POST(request: NextRequest) {
    try {
        const body = await request.json()
        const { filename, contentType, channelId } = body

        if (!filename || !contentType || !channelId) {
            return NextResponse.json({ error: 'Missing parameters' }, { status: 400 })
        }

        const supabase = await createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // Generate a unique file path
        // Format: {channelId}/{userId}/{timestamp}_{random}.{extension} (Use safe characters only)
        const timestamp = Date.now()
        const random = Math.random().toString(36).substring(7)
        const ext = filename.split('.').pop() || 'bin'
        const safeFilename = `${timestamp}_${random}.${ext}`
        const key = `${channelId}/${user.id}/${safeFilename}`

        // Create the PutObject command
        const command = new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key,
            ContentType: contentType,
        })

        // Generate the pre-signed URL (valid for 5 minutes)
        const signedUrl = await getSignedUrl(R2, command, { expiresIn: 300 })

        // Construct the public URL
        const publicDomain = process.env.R2_PUBLIC_DOMAIN?.replace(/\/$/, '') // Remove trailing slash if present
        const publicUrl = `${publicDomain}/${key}`

        return NextResponse.json({
            uploadUrl: signedUrl,
            publicUrl: publicUrl,
            key: key
        })

    } catch (error) {
        console.error('Error generating signed URL:', error)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}
