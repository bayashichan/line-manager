'use client'

import { useState, useEffect, useRef, useMemo, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { getCookie } from '@/lib/utils'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Send, Loader2, Image as ImageIcon, Smile, ArrowLeft, Clock, X, AlertCircle } from 'lucide-react'
import EmojiPicker from 'emoji-picker-react'
import imageCompression from 'browser-image-compression'
import { uploadToR2 as uploadFileToR2 } from '@/lib/storage/upload-client'
import { formatJstDateTime, formatJstShort } from '@/lib/reminders/timing'
import type { MessageContent, ScheduledChatMessage } from '@/types'

// 型定義
interface ChatUser {
    id: string
    line_user_id: string
    display_name: string
    internal_name?: string // Added
    picture_url: string
    last_message_at: string
    unread_count: number
    last_message_content?: string // Added
}

interface ChatMessage {
    id: string
    sender: 'user' | 'admin'
    content_type: string
    content: any
    created_at: string
    read_at: string | null
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000

/** 日本時間の日付（YYYY-MM-DD）と時刻（HH:MM）。予約日時の入力欄に使う */
function toJstInputs(date: Date): { date: string; time: string } {
    const iso = new Date(date.getTime() + JST_OFFSET_MS).toISOString()
    return { date: iso.slice(0, 10), time: iso.slice(11, 16) }
}

/** 予約日時の入力欄（日本時間）を実際の時刻にする。未入力・不正なら null */
function fromJstInputs(date: string, time: string): Date | null {
    if (!date || !time) return null
    const d = new Date(`${date}T${time}:00+09:00`)
    return isNaN(d.getTime()) ? null : d
}

export default function ChatsPageWrapper() {
    return (
        <Suspense fallback={<div className="flex justify-center p-8"><Loader2 className="animate-spin text-slate-400" /></div>}>
            <ChatsPage />
        </Suspense>
    )
}

function ChatsPage() {
    const searchParams = useSearchParams()
    const targetUserId = searchParams.get('userId')
    const [users, setUsers] = useState<ChatUser[]>([])
    const [selectedUser, setSelectedUser] = useState<ChatUser | null>(null)
    const [messages, setMessages] = useState<ChatMessage[]>([])
    const [newMessage, setNewMessage] = useState('')
    const [isLoadingUsers, setIsLoadingUsers] = useState(true)
    const [isSending, setIsSending] = useState(false)
    const [channelId, setChannelId] = useState<string | null>(null)

    const supabase = createClient()
    const messagesViewportRef = useRef<HTMLDivElement>(null)
    const [isInputFocused, setIsInputFocused] = useState(false) // Added state at correct location

    // 送信予約（チャンネル全体の「予約中・送信中・送れなかった」予約。トーク画面と一覧の時計マークに使う）
    const [scheduledMessages, setScheduledMessages] = useState<ScheduledChatMessage[]>([])
    const [isScheduleMode, setIsScheduleMode] = useState(false)
    const [scheduleDate, setScheduleDate] = useState('')
    const [scheduleTime, setScheduleTime] = useState('')
    const [cancellingScheduleId, setCancellingScheduleId] = useState<string | null>(null)

    // 表示名取得ヘルパー (管理用ネームを優先、なければLINE名)
    const getDisplayName = (user: ChatUser) => {
        return user.internal_name || user.display_name
    }

    // 初期ロード：チャンネルIDと友だちリスト取得
    useEffect(() => {
        async function loadInitialData() {
            // チャンネルID取得（クッキー優先）
            const { data: { user } } = await supabase.auth.getUser()
            if (!user) return

            const savedChannelId = getCookie('line-manager-channel-id')

            let query = supabase
                .from('channel_members')
                .select('channel_id')
                .eq('profile_id', user.id)

            if (savedChannelId) {
                query = query.eq('channel_id', savedChannelId)
            } else {
                query = query.limit(1)
            }

            const { data: channelMembers } = await query

            // 配列で返ってくる可能性（eqなら複数、limit(1)なら1つだがsupabaseの返り値は条件次第）
            // single()を使わない形にして配列チェック
            const member = channelMembers && channelMembers.length > 0 ? channelMembers[0] : null

            if (member) {
                setChannelId(member.channel_id)
                fetchUsers(member.channel_id)
                fetchScheduledMessages(member.channel_id)
            }
        }
        loadInitialData()
    }, [])

    // 友だちリスト取得
    async function fetchUsers(cId: string) {
        setIsLoadingUsers(true)
        const { data } = await supabase
            .from('line_users')
            .select('*')
            .eq('channel_id', cId)
            .order('last_message_at', { ascending: false, nullsFirst: false })
            .order('updated_at', { ascending: false })

        if (data) setUsers(data as any)
        setIsLoadingUsers(false)
    }

    // 送信予約の取得（送信済み・取り消し済みは出さない）
    async function fetchScheduledMessages(cId: string) {
        const { data } = await supabase
            .from('scheduled_chat_messages')
            .select('*')
            .eq('channel_id', cId)
            .in('status', ['pending', 'sending', 'failed'])
            .order('send_at', { ascending: true })

        if (data) setScheduledMessages(data as ScheduledChatMessage[])
    }

    // 予約の送信（別の画面を開いている友だちの分も含む）を一覧に反映するため、定期的に取り直す
    useEffect(() => {
        if (!channelId) return
        const timer = setInterval(() => fetchScheduledMessages(channelId), 60 * 1000)
        return () => clearInterval(timer)
    }, [channelId])

    // 友だちごとの予約の有無（一覧の時計マーク・失敗マーク）
    const scheduleSummary = useMemo(() => {
        const summary = new Map<string, { pending: boolean; failed: boolean }>()
        for (const item of scheduledMessages) {
            const entry = summary.get(item.line_user_id) ?? { pending: false, failed: false }
            if (item.status === 'failed') entry.failed = true
            else entry.pending = true
            summary.set(item.line_user_id, entry)
        }
        return summary
    }, [scheduledMessages])

    // URLパラメータによる自動選択
    useEffect(() => {
        if (targetUserId && users.length > 0 && !selectedUser) {
            const target = users.find(u => u.id === targetUserId)
            if (target) {
                setSelectedUser(target)
            }
        }
    }, [targetUserId, users, selectedUser])

    // 友だちリストのリアルタイム更新（未読バッジ・並び順）
    useEffect(() => {
        if (!channelId) return

        const channel = supabase
            .channel(`line_users_list:${channelId}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'line_users',
                    filter: `channel_id=eq.${channelId}`,
                },
                (payload) => {
                    if (payload.eventType === 'UPDATE') {
                        const updatedUser = payload.new as ChatUser
                        setUsers((prev) => {
                            const newUsers = prev.map((u) => (u.id === updatedUser.id ? { ...u, ...updatedUser } : u))
                            // ソート (last_message_at 降順)
                            return newUsers.sort((a, b) => {
                                const tA = new Date(a.last_message_at || 0).getTime()
                                const tB = new Date(b.last_message_at || 0).getTime()
                                return tB - tA
                            })
                        })
                    } else if (payload.eventType === 'INSERT') {
                        const newUser = payload.new as ChatUser
                        setUsers((prev) => [newUser, ...prev])
                    }
                }
            )
            .subscribe()

        return () => {
            supabase.removeChannel(channel)
        }
    }, [channelId])

    // ユーザー選択時の処理
    useEffect(() => {
        if (!selectedUser || !channelId) return

        // メッセージ取得
        fetchMessages(selectedUser.id)
        // 既読処理
        markAsRead(selectedUser.id)

        // リアルタイム購読開始
        const channel = supabase
            .channel(`chat:${selectedUser.id}`)
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'chat_messages',
                    filter: `line_user_id=eq.${selectedUser.id}`,
                },
                (payload) => {
                    const newMsg = payload.new as ChatMessage
                    setMessages((prev) => [...prev, newMsg])
                    // 自分が受信者なら既読処理（本来はフォーカス判定なども必要）
                    if (newMsg.sender === 'user') {
                        markAsRead(selectedUser.id)
                    } else {
                        // 予約したメッセージが送られたら、予約の表示を消す
                        fetchScheduledMessages(channelId)
                    }
                    scrollToBottom()
                }
            )
            .subscribe()

        return () => {
            supabase.removeChannel(channel)
        }
    }, [selectedUser, channelId])

    async function fetchMessages(userId: string) {
        const { data } = await supabase
            .from('chat_messages')
            .select('*')
            .eq('line_user_id', userId)
            .order('created_at', { ascending: true })

        if (data) {
            setMessages(data as any)
            scrollToBottom()
        }
    }

    async function markAsRead(userId: string) {
        if (!channelId) return
        await fetch('/api/chat/read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channelId, lineUserId: userId }),
        })

        // UI上の未読数リセット
        setUsers(prev => prev.map(u =>
            u.id === userId ? { ...u, unread_count: 0 } : u
        ))
    }

    // メッセージエリアだけを最下部へスクロール
    // (scrollIntoViewはページ全体までスクロールさせ、相手の名前欄が画面外に出てしまうため使わない)
    const scrollToBottom = () => {
        setTimeout(() => {
            const viewport = messagesViewportRef.current
            viewport?.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' })
        }, 100)
    }

    // URL判定
    const isUrl = (text: string) => {
        return text.match(/^https?:\/\//)
    }

    // 絵文字
    const [showEmojiPicker, setShowEmojiPicker] = useState(false)
    const onEmojiClick = (emojiObject: { emoji: string }) => {
        setNewMessage(prev => prev + emojiObject.emoji)
        setShowEmojiPicker(false)
    }

    // ファイルアップロード & 送信管理
    const fileInputRef = useRef<HTMLInputElement>(null)
    const [selectedFile, setSelectedFile] = useState<File | null>(null)
    const [filePreview, setFilePreview] = useState<string | null>(null)
    const [uploadError, setUploadError] = useState<string | null>(null)

    // 動画サムネイル生成
    const generateVideoThumbnail = async (file: File): Promise<File> => {
        return new Promise((resolve, reject) => {
            const video = document.createElement('video')
            video.preload = 'metadata'
            video.src = URL.createObjectURL(file)
            video.muted = true
            video.playsInline = true

            video.onloadedmetadata = () => {
                video.currentTime = 0.5 // 0.5秒時点をキャプチャ
            }

            video.onseeked = () => {
                const canvas = document.createElement('canvas')
                canvas.width = video.videoWidth
                canvas.height = video.videoHeight
                const ctx = canvas.getContext('2d')
                if (!ctx) {
                    reject(new Error('Canvas context not available'))
                    return
                }
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

                canvas.toBlob((blob) => {
                    if (blob) {
                        const thumbFile = new File([blob], 'thumbnail.jpg', { type: 'image/jpeg' })
                        resolve(thumbFile)
                    } else {
                        reject(new Error('Thumbnail generation failed'))
                    }
                    URL.revokeObjectURL(video.src)
                }, 'image/jpeg', 0.8)
            }

            video.onerror = () => {
                URL.revokeObjectURL(video.src)
                reject(new Error('Video load failed'))
            }
        })
    }

    const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return

        // リセット
        setUploadError(null)
        setSelectedFile(file)

        // プレビュー生成
        if (file.type.startsWith('image/')) {
            const reader = new FileReader()
            reader.onload = (e) => setFilePreview(e.target?.result as string)
            reader.readAsDataURL(file)
        } else if (file.type.startsWith('video/')) {
            setFilePreview(null) // 動画は処理重いので一旦アイコン表示等を想定（今回は枠のみ）
        } else {
            setFilePreview(null)
        }
    }

    const clearFileSelection = () => {
        setSelectedFile(null)
        setFilePreview(null)
        setUploadError(null)
        if (fileInputRef.current) fileInputRef.current.value = ''
    }

    // R2へのアップロード（共通ヘルパーに委譲）
    const uploadToR2 = async (file: File): Promise<string> => {
        if (!channelId) throw new Error('チャンネルが選択されていません')
        return uploadFileToR2(file, channelId, { prefix: 'chats' })
    }

    // メッセージ送信（テキスト または ファイル）
    const handleSendMessage = async (e: React.FormEvent) => {
        e.preventDefault()
        if ((!newMessage.trim() && !selectedFile) || !selectedUser || !channelId || isSending) return

        // 予約のときは、ファイルをアップロードする前に日時を確かめる
        let sendAt: Date | null = null
        if (isScheduleMode) {
            sendAt = fromJstInputs(scheduleDate, scheduleTime)
            if (!sendAt) return setUploadError('送信する日時を入力してください')
            if (sendAt.getTime() <= Date.now()) return setUploadError('過去の日時は指定できません')
        }

        setIsSending(true)
        setUploadError(null)

        try {
            // 1. ファイルがある場合はアップロード
            let uploadedContent: any = null

            if (selectedFile) {
                // プレビュー画像（動画サムネ or 画像圧縮）
                let previewUrl = ''

                if (selectedFile.type.startsWith('image/')) {
                    // 画像圧縮 (プレビュー用)
                    const options = {
                        maxSizeMB: 1, // LINE制限: 1MB以下
                        maxWidthOrHeight: 1024,
                        useWebWorker: true,
                        fileType: 'image/jpeg'
                    }
                    try {
                        const compressedFile = await imageCompression(selectedFile, options)
                        // プレビューもR2へアップロード
                        const compressedName = `preview_${selectedFile.name}`
                        // 注意: R2アップロード関数を再利用したいが、File型が必要
                        const prevFile = new File([compressedFile], compressedName, { type: 'image/jpeg' })
                        previewUrl = await uploadToR2(prevFile)
                    } catch (e) {
                        console.warn('Image compression failed', e)
                    }
                } else if (selectedFile.type.startsWith('video/')) {
                    // 動画サムネイル生成
                    try {
                        const thumbFile = await generateVideoThumbnail(selectedFile)
                        // サムネも1MB以下に圧縮
                        const options = { maxSizeMB: 1, maxWidthOrHeight: 1024, useWebWorker: true, fileType: 'image/jpeg' }
                        const compressedThumb = await imageCompression(thumbFile, options)

                        const thumbName = `thumb_${selectedFile.name}.jpg`
                        const prevFile = new File([compressedThumb], thumbName, { type: 'image/jpeg' })
                        previewUrl = await uploadToR2(prevFile)
                    } catch (e) {
                        console.warn('Video thumbnail generation failed', e)
                    }
                }

                // オリジナルアップロード (R2)
                const publicUrl = await uploadToR2(selectedFile)

                // メッセージ用オブジェクト作成
                const type = selectedFile.type.startsWith('image/') ? 'image' :
                    selectedFile.type.startsWith('video/') ? 'video' : 'file'

                const finalPreviewUrl = previewUrl || publicUrl // フォールバック

                if (type === 'file') {
                    uploadedContent = { type: 'text', text: `ファイルが送信されました: ${publicUrl}` }
                } else {
                    uploadedContent = { type, originalContentUrl: publicUrl, previewImageUrl: finalPreviewUrl }
                }
            }

            // 2-a. 送信予約（テキスト → ファイルの順で、指定した日時にまとめて送る）
            if (sendAt) {
                const blocks: MessageContent[] = []
                if (newMessage.trim()) blocks.push({ type: 'text', text: newMessage })
                if (uploadedContent) blocks.push(uploadedContent)
                await scheduleMessageToApi(blocks, sendAt)

                setNewMessage('')
                clearFileSelection()
                // 次のメッセージをうっかり予約しないよう、すぐ送るモードに戻す
                setIsScheduleMode(false)
                await fetchScheduledMessages(channelId)
                scrollToBottom()
                return
            }

            // 2-b. API送信
            // ファイルがある場合はファイルを優先的に送信（テキストとの同時送信は今回は未対応、別々に送るならループなど必要）
            // ここでは「テキストがあればテキスト送信」->「ファイルがあればファイル送信」の順で行う

            if (newMessage.trim()) {
                await sendMessageToApi('text', { text: newMessage })
            }

            if (uploadedContent) {
                await sendMessageToApi(uploadedContent.type === 'text' ? 'file' : uploadedContent.type, uploadedContent)
            }

            // 成功したらフォームクリア
            setNewMessage('')
            clearFileSelection()

            // ユーザーリスト更新
            setUsers(prev => {
                const others = prev.filter(u => u.id !== selectedUser.id)
                return [{ ...selectedUser, last_message_at: new Date().toISOString() }, ...others]
            })

        } catch (error: any) {
            console.error('送信エラー:', error)
            setUploadError(error.message || '送信に失敗しました')
        } finally {
            setIsSending(false)
            if (fileInputRef.current) fileInputRef.current.value = ''
        }
    }

    const sendMessageToApi = async (type: string, content: any) => {
        if (!selectedUser || !channelId) return

        // type: text, image, video, file (internal handling)
        // content: { text? , originalContentUrl?, previewImageUrl? }

        const body = {
            channelId,
            lineUserId: selectedUser.id,
            ...(type === 'text' ? { text: content.text, type: 'text' } :
                type === 'file' ? { text: content.text, type: 'text' } : // fileは実質textとして送る
                    type === 'image' ? { originalContentUrl: content.originalContentUrl, previewImageUrl: content.previewImageUrl, type: 'image' } :
                        type === 'video' ? { originalContentUrl: content.originalContentUrl, previewImageUrl: content.previewImageUrl, type: 'video' } : {})
        }

        const res = await fetch('/api/chat/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })

        if (!res.ok) {
            const errData = await res.json()
            throw new Error(errData.error || 'API Error')
        }
    }

    const scheduleMessageToApi = async (blocks: MessageContent[], sendAt: Date) => {
        if (!selectedUser || !channelId) return

        const res = await fetch('/api/chat/schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                channelId,
                lineUserId: selectedUser.id,
                sendAt: sendAt.toISOString(),
                messages: blocks,
            }),
        })

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}))
            throw new Error(errData.error || '予約に失敗しました')
        }
    }

    // 予約モードの切り替え（初めて開くときは「次の正時」を入れておく）
    const toggleScheduleMode = () => {
        if (!isScheduleMode) {
            const current = fromJstInputs(scheduleDate, scheduleTime)
            if (!current || current.getTime() <= Date.now()) {
                const nextHour = new Date(Date.now() + 60 * 60 * 1000)
                nextHour.setUTCMinutes(0, 0, 0) // 日本時間との差は9時間ちょうどなので、正時のまま
                const { date, time } = toJstInputs(nextHour)
                setScheduleDate(date)
                setScheduleTime(time)
            }
        }
        setUploadError(null)
        setIsScheduleMode(!isScheduleMode)
    }

    // 予約の取り消し（送れなかった予約は「閉じる」で一覧から消す）
    const cancelScheduledMessage = async (item: ScheduledChatMessage) => {
        const isFailed = item.status === 'failed'
        if (!isFailed && !confirm(`${formatJstDateTime(new Date(item.send_at))} に送る予約を取り消しますか？`)) return
        if (!channelId) return

        setCancellingScheduleId(item.id)
        try {
            const res = await fetch('/api/chat/schedule/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: item.id }),
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) alert(data.error || '取り消しに失敗しました')
            await fetchScheduledMessages(channelId)
        } finally {
            setCancellingScheduleId(null)
        }
    }

    // 日付フォーマット
    const formatDate = (dateStr: string) => {
        const d = new Date(dateStr)
        return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
    }

    return (
        // 高さ = 画面の高さ - (ヘッダー + mainの上下余白)。ページ自体がスクロールしないように収める
        <div className="flex h-[calc(100dvh-10rem)] lg:h-[calc(100dvh-8rem)] gap-4">
            {/* 左サイドバー：友だちリスト (モバイル時はユーザー未選択時のみ表示) */}
            <Card className={`w-full lg:w-80 flex-col overflow-hidden bg-white dark:bg-slate-950 border-slate-200 dark:border-slate-800 ${selectedUser ? 'hidden lg:flex' : 'flex'}`}>
                <div className="p-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900">
                    <h2 className="font-bold text-lg text-slate-800 dark:text-slate-100">チャット</h2>
                </div>
                {/* Radix の ScrollArea は中身を display: table で包み、長い行に合わせて一覧ごと横に広がる
                    （右端の日付・未読数が切れる）ため、block にして各行の省略表示（truncate）を効かせる */}
                <ScrollArea className="flex-1" viewportClassName="[&>div]:!block">
                    {isLoadingUsers ? (
                        <div className="flex justify-center p-4"><Loader2 className="animate-spin text-slate-400" /></div>
                    ) : users.length === 0 ? (
                        <div className="p-4 text-center text-slate-500">友だちがいません</div>
                    ) : (
                        <div className="flex flex-col">
                            {users.map((user) => (
                                <button
                                    key={user.id}
                                    onClick={() => setSelectedUser(user)}
                                    className={`flex items-center gap-3 p-4 text-left transition-colors hover:bg-slate-100 dark:hover:bg-slate-800/50 ${selectedUser?.id === user.id ? 'bg-blue-50 dark:bg-blue-900/20 border-r-4 border-blue-500' : ''
                                        }`}
                                >
                                    <Avatar>
                                        <AvatarImage src={user.picture_url} />
                                        <AvatarFallback>{user.display_name?.slice(0, 2)}</AvatarFallback>
                                    </Avatar>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex justify-between items-baseline mb-1">
                                            <span className="font-semibold truncate text-sm text-slate-900 dark:text-slate-100">
                                                {getDisplayName(user)}
                                            </span>
                                            {user.last_message_at && (
                                                <span className="text-xs text-slate-500">
                                                    {new Date(user.last_message_at).toLocaleDateString()}
                                                </span>
                                            )}
                                        </div>
                                        <div className="flex justify-between items-center">
                                            <p className="text-xs text-slate-500 truncate h-4 min-w-0 flex-1">
                                                {user.last_message_content || ''}
                                            </p>
                                            {scheduleSummary.get(user.id)?.failed ? (
                                                <span title="送れなかった予約があります" className="shrink-0 ml-1">
                                                    <AlertCircle className="w-3.5 h-3.5 text-red-500" />
                                                </span>
                                            ) : scheduleSummary.get(user.id)?.pending ? (
                                                <span title="送信予約があります" className="shrink-0 ml-1">
                                                    <Clock className="w-3.5 h-3.5 text-blue-500" />
                                                </span>
                                            ) : null}
                                            {user.unread_count > 0 && (
                                                <span className="bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[1.2rem] text-center">
                                                    {user.unread_count}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </button>
                            ))}
                        </div>
                    )}
                </ScrollArea>
            </Card>

            {/* メイン：トーク画面 (モバイル時はユーザー選択時のみ表示) */}
            <Card className={`flex-1 flex-col overflow-hidden bg-white dark:bg-slate-950 border-slate-200 dark:border-slate-800 ${selectedUser ? 'flex' : 'hidden lg:flex'}`}>
                {selectedUser ? (
                    <>
                        {/* ヘッダー (メッセージをスクロールしても上部に固定) */}
                        <div className="shrink-0 p-3 lg:p-4 border-b border-slate-200 dark:border-slate-800 flex items-center gap-3 bg-white dark:bg-slate-900 shadow-sm z-10">
                            {/* モバイル用戻るボタン */}
                            <Button
                                variant="ghost"
                                size="icon"
                                className="lg:hidden -ml-2"
                                onClick={() => setSelectedUser(null)}
                            >
                                <ArrowLeft className="w-5 h-5" />
                            </Button>
                            <div className="flex items-center gap-3 min-w-0">
                                <Avatar className="h-8 w-8 shrink-0">
                                    <AvatarImage src={selectedUser.picture_url} />
                                    <AvatarFallback>{(getDisplayName(selectedUser) || '?').slice(0, 2)}</AvatarFallback>
                                </Avatar>
                                <span className="font-bold truncate text-slate-900 dark:text-slate-100">
                                    {getDisplayName(selectedUser)}
                                </span>
                            </div>
                        </div>

                        {/* メッセージエリア */}
                        <ScrollArea
                            className="flex-1 min-h-0 p-4 bg-slate-100 dark:bg-slate-900/50"
                            viewportRef={messagesViewportRef}
                            viewportClassName="overscroll-contain"
                        >
                            <div className="flex flex-col gap-4">
                                {messages.map((msg) => {
                                    const isAdmin = msg.sender === 'admin'
                                    return (
                                        <div
                                            key={msg.id}
                                            className={`flex ${isAdmin ? 'justify-end' : 'justify-start'}`}
                                        >
                                            {!isAdmin && (
                                                <Avatar className="h-8 w-8 mr-2 mt-1">
                                                    <AvatarImage src={selectedUser.picture_url} />
                                                    <AvatarFallback>{selectedUser.display_name?.slice(0, 2)}</AvatarFallback>
                                                </Avatar>
                                            )}

                                            <div className={`max-w-[70%] ${isAdmin ? 'items-end' : 'items-start'} flex flex-col`}>
                                                <div
                                                    className={`px-4 py-2 rounded-2xl shadow-sm text-sm whitespace-pre-wrap break-words ${isAdmin
                                                        ? 'bg-blue-600 text-white rounded-tr-none'
                                                        : 'bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 rounded-tl-none border border-slate-200 dark:border-slate-700'
                                                        }`}
                                                >
                                                    {msg.content_type === 'text' ? (
                                                        msg.content.text
                                                        // URLならリンクにする簡易実装も可能だが、今回はテキストとして表示
                                                    ) : msg.content_type === 'image' ? (
                                                        // eslint-disable-next-line @next/next/no-img-element
                                                        <a href={msg.content.originalContentUrl} target="_blank" rel="noopener noreferrer">
                                                            <img src={msg.content.originalContentUrl} alt="sent image" className="max-w-xs rounded-lg hover:opacity-90 transition-opacity" />
                                                        </a>
                                                    ) : msg.content_type === 'video' ? (
                                                        <video src={msg.content.originalContentUrl} controls className="max-w-xs rounded-lg" />
                                                    ) : (
                                                        <span className="italic opacity-80">
                                                            {msg.content_type} (表示未対応)
                                                        </span>
                                                    )}
                                                </div>
                                                <span className="text-[10px] text-slate-400 mt-1 px-1">
                                                    {isAdmin && msg.read_at && <span className="mr-2 text-blue-500">既読</span>}
                                                    {formatDate(msg.created_at)}
                                                </span>
                                            </div>
                                        </div>
                                    )
                                })}

                                {/* 送信予約（まだ送っていないもの・送れなかったもの） */}
                                {scheduledMessages
                                    .filter((item) => item.line_user_id === selectedUser.id)
                                    .map((item) => {
                                        const isFailed = item.status === 'failed'
                                        const isCancelling = cancellingScheduleId === item.id
                                        return (
                                            <div key={`scheduled-${item.id}`} className="flex justify-end">
                                                <div className="max-w-[70%] items-end flex flex-col">
                                                    <div
                                                        className={`px-4 py-2 rounded-2xl rounded-tr-none text-sm whitespace-pre-wrap break-words border-2 border-dashed flex flex-col gap-2 ${isFailed
                                                            ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100'
                                                            : 'border-blue-300 bg-blue-50 text-slate-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-slate-100'
                                                            }`}
                                                    >
                                                        {item.content.map((block, i) =>
                                                            block.type === 'text' ? (
                                                                <span key={i}>{block.text}</span>
                                                            ) : block.type === 'image' ? (
                                                                // eslint-disable-next-line @next/next/no-img-element
                                                                <img key={i} src={block.previewImageUrl || block.originalContentUrl} alt="予約した画像" className="max-w-[12rem] rounded-lg" />
                                                            ) : block.type === 'video' ? (
                                                                <video key={i} src={block.originalContentUrl} poster={block.previewImageUrl} controls className="max-w-[12rem] rounded-lg" />
                                                            ) : null
                                                        )}
                                                    </div>
                                                    <p className={`text-[11px] mt-1 px-1 text-right ${isFailed ? 'text-red-600 dark:text-red-400' : 'text-blue-600 dark:text-blue-400'}`}>
                                                        {isFailed ? (
                                                            <>
                                                                <AlertCircle className="inline w-3 h-3 mr-1 -mt-0.5" />
                                                                {formatJstShort(new Date(item.send_at))} の予約を送れませんでした
                                                                {item.error_message ? `（${item.error_message}）` : ''}
                                                            </>
                                                        ) : (
                                                            <>
                                                                <Clock className="inline w-3 h-3 mr-1 -mt-0.5" />
                                                                {item.status === 'sending' ? '送信中…' : `${formatJstShort(new Date(item.send_at))} に送信予定`}
                                                            </>
                                                        )}
                                                        {item.status !== 'sending' && (
                                                            <button
                                                                type="button"
                                                                onClick={() => cancelScheduledMessage(item)}
                                                                disabled={isCancelling}
                                                                className="ml-2 whitespace-nowrap underline underline-offset-2 text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 disabled:opacity-50"
                                                            >
                                                                {isCancelling ? '処理中…' : isFailed ? '閉じる' : '取り消す'}
                                                            </button>
                                                        )}
                                                    </p>
                                                </div>
                                            </div>
                                        )
                                    })}
                            </div>
                        </ScrollArea>

                        {/* 入力フォーム */}
                        <div className="p-4 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 relative flex flex-col">
                            {/* ファイルプレビューエリア */}
                            {selectedFile && (
                                <div className="mb-2 p-2 bg-slate-100 dark:bg-slate-800 rounded-lg flex items-center justify-between">
                                    <div className="flex items-center gap-2 overflow-hidden">
                                        {filePreview ? (
                                            // eslint-disable-next-line @next/next/no-img-element
                                            <img src={filePreview} alt="preview" className="h-10 w-10 object-cover rounded" />
                                        ) : (
                                            <div className="h-10 w-10 bg-slate-200 dark:bg-slate-700 rounded flex items-center justify-center">
                                                <ImageIcon className="h-6 w-6 text-slate-400" />
                                            </div>
                                        )}
                                        <div className="flex flex-col min-w-0">
                                            <span className="text-sm font-medium truncate">{selectedFile.name}</span>
                                            <span className="text-xs text-slate-500">{(selectedFile.size / 1024 / 1024).toFixed(2)} MB</span>
                                        </div>
                                    </div>
                                    <Button variant="ghost" size="sm" onClick={clearFileSelection}>
                                        ✕
                                    </Button>
                                </div>
                            )}

                            {/* エラー表示エリア */}
                            {uploadError && (
                                <div className="mb-2 p-2 bg-red-100 text-red-600 text-sm rounded border border-red-200">
                                    {uploadError}
                                </div>
                            )}

                            {/* 送信予約の日時（日本時間） */}
                            {isScheduleMode && (
                                <div className="mb-2 p-2 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 rounded-lg flex flex-col gap-1.5">
                                    {/* スマホ: 1行目「送信予約 … やめる」・2行目に日時 / PC: 1行に並べる */}
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="order-1 flex items-center gap-1 text-sm font-medium text-blue-700 dark:text-blue-300">
                                            <Clock className="w-4 h-4" />
                                            送信予約
                                        </span>
                                        <div className="order-3 w-full sm:order-2 sm:w-auto flex gap-2">
                                            <Input
                                                type="date"
                                                value={scheduleDate}
                                                min={toJstInputs(new Date()).date}
                                                onChange={(e) => setScheduleDate(e.target.value)}
                                                disabled={isSending}
                                                className="h-9 flex-1 sm:flex-none sm:w-auto bg-white dark:bg-slate-900"
                                                aria-label="送信する日付"
                                            />
                                            <Input
                                                type="time"
                                                value={scheduleTime}
                                                onChange={(e) => setScheduleTime(e.target.value)}
                                                disabled={isSending}
                                                className="h-9 flex-1 sm:flex-none sm:w-auto bg-white dark:bg-slate-900"
                                                aria-label="送信する時刻"
                                            />
                                        </div>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            onClick={toggleScheduleMode}
                                            disabled={isSending}
                                            className="order-2 sm:order-3 ml-auto h-8 px-2 text-slate-500"
                                            title="予約をやめて、すぐ送るに戻す"
                                        >
                                            <X className="w-4 h-4 mr-1" />
                                            やめる
                                        </Button>
                                    </div>
                                    <p className="text-xs text-slate-600 dark:text-slate-300 px-1">
                                        {(() => {
                                            const at = fromJstInputs(scheduleDate, scheduleTime)
                                            if (!at) return '日付と時刻を入力してください'
                                            if (at.getTime() <= Date.now()) return '過去の日時は指定できません'
                                            return `${formatJstDateTime(at)} に送信します（日本時間）`
                                        })()}
                                    </p>
                                </div>
                            )}

                            {/* 絵文字ピッカー */}
                            {showEmojiPicker && (
                                <div className="absolute bottom-16 left-4 z-50">
                                    <EmojiPicker onEmojiClick={onEmojiClick} />
                                </div>
                            )}

                            <form onSubmit={handleSendMessage} className="flex gap-2 items-center">
                                {/* ファイル選択（画像アイコン）*/}
                                <input
                                    type="file"
                                    ref={fileInputRef}
                                    onChange={handleFileSelect}
                                    className="hidden"
                                    accept="image/*,video/*,application/pdf"
                                />
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className={`text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 ${selectedFile ? 'text-blue-500' : ''}`}
                                    disabled={isSending}
                                    onClick={() => fileInputRef.current?.click()}
                                >
                                    <ImageIcon className="w-5 h-5" />
                                </Button>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className={`hover:text-amber-500 dark:hover:text-amber-400 ${showEmojiPicker ? 'text-amber-500' : 'text-slate-400'}`}
                                    disabled={isSending}
                                    onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                                >
                                    <Smile className="w-5 h-5" />
                                </Button>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    title="日時を指定して送る（送信予約）"
                                    aria-label="送信予約"
                                    aria-pressed={isScheduleMode}
                                    className={`hover:text-blue-600 dark:hover:text-blue-400 ${isScheduleMode ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400'}`}
                                    disabled={isSending}
                                    onClick={toggleScheduleMode}
                                >
                                    <Clock className="w-5 h-5" />
                                </Button>

                                <div className="flex-1 relative">
                                    <Textarea
                                        value={newMessage}
                                        onChange={(e) => setNewMessage(e.target.value)}
                                        onFocus={() => setIsInputFocused(true)}
                                        onBlur={() => setIsInputFocused(false)}
                                        placeholder={
                                            selectedFile ? "メッセージを追加（任意）..."
                                                : isScheduleMode ? "予約するメッセージを入力... (Enter=改行, Cmd+Enter=予約)"
                                                    : "メッセージを入力... (Enter=改行, Cmd+Enter=送信)"
                                        }
                                        className={`resize-none py-3 bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 transition-all duration-300 ease-in-out ${isInputFocused ? 'min-h-[160px]' : 'min-h-[44px]'
                                            }`}
                                        style={{ maxHeight: '400px' }}
                                        disabled={isSending}
                                        onKeyDown={(e) => {
                                            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                                                e.preventDefault()
                                                handleSendMessage(e)
                                            }
                                        }}
                                    />
                                </div>
                                <Button
                                    type="submit"
                                    disabled={isSending || (!newMessage.trim() && !selectedFile)}
                                    className="bg-blue-600 hover:bg-blue-700 text-white self-end mb-1"
                                    aria-label={isScheduleMode ? '予約する' : '送信'}
                                >
                                    {isSending ? (
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                    ) : isScheduleMode ? (
                                        <>
                                            <Clock className="w-4 h-4 sm:mr-1" />
                                            {/* スマホでは入力欄を狭めないよう、アイコンだけにする */}
                                            <span className="hidden sm:inline">予約</span>
                                        </>
                                    ) : (
                                        <Send className="w-4 h-4" />
                                    )}
                                </Button>
                            </form>
                        </div>
                    </>
                ) : (
                    <div className="flex-1 flex flex-col items-center justify-center text-slate-400 bg-slate-50/50 dark:bg-slate-900/50">
                        <div className="bg-slate-100 dark:bg-slate-800 p-6 rounded-full mb-4">
                            <Send className="w-12 h-12 text-slate-300 dark:text-slate-600" />
                        </div>
                        <p className="text-center">左側のリストから友だちを選択して<br />チャットを開始してください</p>
                    </div>
                )}
            </Card>
        </div >
    )
}
