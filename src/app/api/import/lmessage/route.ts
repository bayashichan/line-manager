import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

// CSV Parser Helper
// Simple CSV split might fail on quoted commas, but considering LMessage format seems standard.
// We can use a regex or just simple split if we know the data structure.
// However, since we have papaparse installed, we can't easily use it in Edge Runtime unless we are careful,
// but usually it works in Node runtime.
// By default Next.js API routes use Node runtime unless specified.

export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData()
        const file = formData.get('file') as File
        const channelId = formData.get('channelId') as string

        if (!file || !channelId) {
            return NextResponse.json({ error: 'File and channelId are required' }, { status: 400 })
        }

        const buffer = Buffer.from(await file.arrayBuffer())

        // 1. Decode Shift-JIS
        const decoder = new TextDecoder('shift_jis')
        const text = decoder.decode(buffer)

        // 2. Split lines
        const lines = text.split(/\r?\n/).filter(line => line.trim() !== '')

        if (lines.length < 3) {
            return NextResponse.json({ error: 'Invalid CSV format: Not enough rows' }, { status: 400 })
        }

        // 3. Parse Headers (Row 1 -> index 1)
        // Helper to parse a CSV line respecting quotes
        const parseLine = (line: string): string[] => {
            const result = []
            let current = ''
            let inQuote = false
            for (let i = 0; i < line.length; i++) {
                const char = line[i]
                if (char === '"') {
                    inQuote = !inQuote
                } else if (char === ',' && !inQuote) {
                    result.push(current.trim())
                    current = ''
                } else {
                    current += char
                }
            }
            result.push(current.trim())
            return result.map(s => s.replace(/^"|"$/g, '').trim())
        }

        const headers = parseLine(lines[1]) // Row 1 is the header row

        // Identify Columns
        const userIdIdx = headers.indexOf('ユーザーID')
        const displayNameIdx = headers.indexOf('LINE表示名')
        const internalNameIdx = headers.indexOf('システム表示名')

        if (userIdIdx === -1) {
            return NextResponse.json({ error: 'Required column "ユーザーID" not found' }, { status: 400 })
        }

        // Identify Tag Columns
        const tagIndices: { index: number, name: string }[] = []
        headers.forEach((header, idx) => {
            if (header.startsWith('タグ_')) {
                // remove "タグ_" prefix
                tagIndices.push({ index: idx, name: header.replace('タグ_', '') })
            }
        })

        const supabase = await createClient()
        let successCount = 0
        let failureCount = 0

        // 4. Process Tags (Ensure all tags exist)
        const allTagNames = tagIndices.map(t => t.name)
        // Fetch existing tags
        const { data: existingTags, error: tagFetchError } = await supabase
            .from('tags')
            .select('id, name')
            .eq('channel_id', channelId)
            .in('name', allTagNames)

        if (tagFetchError) throw tagFetchError

        const existingTagMap = new Map<string, string>() // Name -> ID
        existingTags?.forEach(t => existingTagMap.set(t.name, t.id))

        // Create missing tags
        const missingTags = allTagNames.filter(name => !existingTagMap.has(name))

        for (const tagName of missingTags) {
            const { data: newTag, error: createError } = await supabase
                .from('tags')
                .insert({
                    channel_id: channelId,
                    name: tagName,
                    color: '#94a3b8' // Default gray
                })
                .select('id')
                .single()

            if (newTag && !createError) {
                existingTagMap.set(tagName, newTag.id)
            }
        }

        // 4.5 Fetch Channel Access Token for Profile Sync
        const { data: channelData } = await supabase
            .from('channels')
            .select('channel_access_token')
            .eq('id', channelId)
            .single()

        const channelAccessToken = channelData?.channel_access_token

        // 5. Process Users (Batch Processing)
        // Collect all data first
        interface UserToUpsert {
            channel_id: string
            line_user_id: string
            display_name: string
            internal_name?: string
            picture_url?: string | null
            status_message?: string | null
        }

        const usersToUpsert: UserToUpsert[] = []
        const csvRows: { lineUserId: string, row: string[] }[] = []

        for (let i = 2; i < lines.length; i++) {
            const row = parseLine(lines[i])
            if (row.length < userIdIdx + 1) continue;

            const lineUserId = row[userIdIdx]
            if (!lineUserId) continue;

            const displayName = displayNameIdx !== -1 ? row[displayNameIdx] : ''
            const internalName = internalNameIdx !== -1 ? row[internalNameIdx] : ''

            usersToUpsert.push({
                channel_id: channelId,
                line_user_id: lineUserId,
                display_name: displayName,
                internal_name: internalName || undefined
            })
            // Keep row data to process tags later
            csvRows.push({ lineUserId, row })
        }

        // Fetch Profiles from LINE (if token exists)
        if (channelAccessToken && usersToUpsert.length > 0) {
            console.log(`Fetching profiles for ${usersToUpsert.length} users...`)

            // Helper for rate limited fetching
            const fetchProfile = async (u: UserToUpsert) => {
                try {
                    const res = await fetch(`https://api.line.me/v2/bot/profile/${u.line_user_id}`, {
                        headers: {
                            Authorization: `Bearer ${channelAccessToken}`
                        }
                    })
                    if (res.ok) {
                        const profile = await res.json()
                        // Update object in place
                        u.picture_url = profile.pictureUrl
                        u.status_message = profile.statusMessage
                        // Should we overwrite display_name with LINE's current one? 
                        // User said: "Csvで取り込んだ友だちの名前は「line表示名」の列をメインに..."
                        // If CSV has it, maybe prioritize CSV? Or prioritize real LINE data?
                        // Usually real LINE data is fresher. Let's update display_name too if we got it?
                        // But user specifically mapped 'LINE表示名' column. 
                        // Let's stick to CSV for name, but use LINE for pic.
                    } else {
                        // console.warn(`Failed to fetch profile for ${u.line_user_id}: ${res.status}`)
                    }
                } catch (e) {
                    console.error(`Error fetching profile for ${u.line_user_id}`, e)
                }
            }

            // Execute in chunks of 10
            const chunkSize = 10
            for (let i = 0; i < usersToUpsert.length; i += chunkSize) {
                const chunk = usersToUpsert.slice(i, i + chunkSize)
                await Promise.all(chunk.map(u => fetchProfile(u)))
                // Optional small delay to be nice to rate limits
                // LINE rate limit is pretty high though.
                await new Promise(r => setTimeout(r, 100))
            }
        }

        if (usersToUpsert.length === 0) {
            return NextResponse.json({ processed: 0, failed: 0, message: 'No valid users found' })
        }

        // Bulk Upsert Users
        const { data: upsertedUsers, error: userError } = await supabase
            .from('line_users')
            .upsert(usersToUpsert, { onConflict: 'channel_id,line_user_id' })
            .select('id, line_user_id')

        if (userError) {
            console.error('Bulk user upsert error:', userError)
            throw new Error('Failed to save users')
        }

        // Map line_user_id -> db_id
        const userIdMap = new Map<string, string>()
        upsertedUsers?.forEach(u => userIdMap.set(u.line_user_id, u.id))

        // Process Tags
        const tagLinksToUpsert: { line_user_id: string, tag_id: string }[] = []

        csvRows.forEach(({ lineUserId, row }) => {
            const dbId = userIdMap.get(lineUserId)
            if (!dbId) return; // Should not happen if upsert succeeded

            tagIndices.forEach(tagCol => {
                const val = row[tagCol.index]
                if (val === '1') {
                    const tagId = existingTagMap.get(tagCol.name)
                    if (tagId) {
                        tagLinksToUpsert.push({
                            line_user_id: dbId,
                            tag_id: tagId
                        })
                    }
                }
            })
        })

        // Bulk Upsert Tag Links
        if (tagLinksToUpsert.length > 0) {
            // Processing in chunks of 1000 just in case, though 300 is small.
            const chunkSize = 1000
            for (let i = 0; i < tagLinksToUpsert.length; i += chunkSize) {
                const chunk = tagLinksToUpsert.slice(i, i + chunkSize)
                const { error: linkError } = await supabase
                    .from('line_user_tags')
                    .upsert(chunk, { onConflict: 'line_user_id, tag_id' }) // requires unique constraint

                if (linkError) console.warn('Bulk tag link error:', linkError)
            }
        }

        return NextResponse.json({
            processed: upsertedUsers?.length || 0,
            failed: 0, // In bulk op, it's all or nothing usually, or we catch error above
            message: `Processed ${upsertedUsers?.length} users`
        })

    } catch (error: any) {
        console.error('Import error:', error)
        return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 })
    }
}
