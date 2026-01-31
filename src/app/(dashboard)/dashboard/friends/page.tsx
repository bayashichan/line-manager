'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button, Input, Card, CardHeader, CardTitle, CardContent } from '@/components/ui'
import { cn, formatDateTime, getRelativeTime, getCookie } from '@/lib/utils'
import type { LineUser, Tag } from '@/types'
import {
    Search,
    Filter,
    Download,
    User,
    Tag as TagIcon,
    MoreHorizontal,
    X,
    Check,
    Loader2,
    Upload,
    FileText,
    AlertCircle,
    Pencil,
    Trash2,
    MessageCircle, // Added
} from 'lucide-react'
import Papa from 'papaparse'

interface LineUserWithTags extends LineUser {
    line_user_tags: { tag_id: string; tags: Tag }[]
}

export default function FriendsPage() {
    const router = useRouter()
    const [friends, setFriends] = useState<LineUserWithTags[]>([])
    const [tags, setTags] = useState<Tag[]>([])
    const [loading, setLoading] = useState(true)
    const [searchQuery, setSearchQuery] = useState('')
    const [selectedTagFilter, setSelectedTagFilter] = useState<string | null>(null)
    const [selectedFriend, setSelectedFriend] = useState<LineUserWithTags | null>(null)
    const [currentChannelId, setCurrentChannelId] = useState<string | null>(null)
    const [showImportModal, setShowImportModal] = useState(false)

    useEffect(() => {
        fetchChannelAndData()
    }, [])

    const fetchChannelAndData = async () => {
        const supabase = createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) return

        // CookieからチャンネルIDを取得
        const savedChannelId = getCookie('line-manager-channel-id')

        // チャンネル取得
        let query = supabase
            .from('channel_members')
            .select('channel_id')
            .eq('profile_id', user.id)

        // Cookieがある場合はそのチャンネルを検索
        if (savedChannelId) {
            query = query.eq('channel_id', savedChannelId)
        } else {
            query = query.limit(1)
        }

        const { data: memberships } = await query

        if (memberships && memberships.length > 0) {
            const channelId = memberships[0].channel_id
            setCurrentChannelId(channelId)
            await fetchData(channelId)
        }

        setLoading(false)
    }

    const fetchData = async (channelId: string) => {
        const supabase = createClient()

        // 友だち一覧取得
        const { data: friendsData } = await supabase
            .from('line_users')
            .select(`
        *,
        line_user_tags (
          tag_id,
          tags (*)
        )
      `)
            .eq('channel_id', channelId)
            .eq('is_blocked', false)
            .order('followed_at', { ascending: false })

        if (friendsData) {
            setFriends(friendsData as LineUserWithTags[])
        }

        // タグ一覧取得
        const { data: tagsData } = await supabase
            .from('tags')
            .select('*')
            .eq('channel_id', channelId)
            .order('name')

        if (tagsData) {
            setTags(tagsData)
        }
    }

    const filteredFriends = friends.filter(friend => {
        const matchesSearch =
            (friend.display_name?.toLowerCase() || '').includes(searchQuery.toLowerCase()) ||
            (friend.internal_name?.toLowerCase() || '').includes(searchQuery.toLowerCase())

        const matchesTag = !selectedTagFilter ||
            friend.line_user_tags.some(ut => ut.tag_id === selectedTagFilter)

        return matchesSearch && matchesTag
    })

    const handleExportCSV = () => {
        const headers = ['LINE表示名', '管理用ネーム', 'タグ', '友だち追加日時']
        const rows = filteredFriends.map(f => [
            f.display_name || '',
            f.internal_name || '',
            f.line_user_tags.map(ut => ut.tags.name).join(', '),
            f.followed_at ? new Date(f.followed_at).toLocaleString('ja-JP') : ''
        ])

        const csv = [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n')
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `friends_${new Date().toISOString().split('T')[0]}.csv`
        a.click()
    }

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
            </div>
        )
    }

    return (
        <div className="space-y-6">
            {/* ヘッダー */}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <h1 className="text-2xl font-bold bg-gradient-to-r from-slate-900 to-slate-700 bg-clip-text text-transparent dark:from-slate-100 dark:to-slate-300">
                        友だち管理
                    </h1>
                    <p className="text-slate-500 dark:text-slate-400 mt-1">
                        {friends.length}人の友だち
                    </p>
                </div>
                <div className="flex gap-2">
                    <Button variant="outline" onClick={() => setShowImportModal(true)}>
                        <Upload className="w-4 h-4" />
                        CSVインポート
                    </Button>
                    <Button variant="outline" onClick={handleExportCSV}>
                        <Download className="w-4 h-4" />
                        CSVエクスポート
                    </Button>
                </div>
            </div>

            {/* フィルター */}
            <div className="flex flex-col gap-4 sm:flex-row">
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <Input
                        placeholder="名前で検索..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-10"
                    />
                </div>
                <div className="flex gap-2 flex-wrap">
                    <Button
                        variant={selectedTagFilter === null ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setSelectedTagFilter(null)}
                    >
                        全て
                    </Button>
                    {tags.map(tag => (
                        <Button
                            key={tag.id}
                            variant={selectedTagFilter === tag.id ? 'default' : 'outline'}
                            size="sm"
                            onClick={() => setSelectedTagFilter(tag.id)}
                            style={selectedTagFilter !== tag.id ? { borderColor: tag.color } : {}}
                        >
                            <span
                                className="w-2 h-2 rounded-full mr-1"
                                style={{ backgroundColor: tag.color }}
                            />
                            {tag.name}
                        </Button>
                    ))}
                </div>
            </div>

            {/* 友だちリスト */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {filteredFriends.map(friend => (
                    <Card
                        key={friend.id}
                        className="cursor-pointer hover:shadow-lg transition-all duration-200 hover:scale-[1.01] group"
                        onClick={() => setSelectedFriend(friend)}
                    >
                        <CardContent className="p-4">
                            <div className="flex items-start gap-3">
                                {friend.picture_url ? (
                                    <img
                                        src={friend.picture_url}
                                        alt={friend.display_name || ''}
                                        className="w-12 h-12 rounded-full object-cover"
                                    />
                                ) : (
                                    <div className="w-12 h-12 rounded-full bg-gradient-to-br from-slate-200 to-slate-300 flex items-center justify-center">
                                        <User className="w-6 h-6 text-slate-500" />
                                    </div>
                                )}
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center justify-between gap-2">
                                        <h3 className="font-medium truncate">
                                            {friend.display_name || friend.internal_name || '名前なし'}
                                        </h3>
                                        <div className="p-1 rounded-full hover:bg-slate-100 text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <Pencil className="w-3 h-3" />
                                        </div>
                                    </div>
                                    {friend.internal_name && friend.display_name && friend.internal_name !== friend.display_name && (
                                        <p className="text-sm text-slate-500 truncate">
                                            管理名: {friend.internal_name}
                                        </p>
                                    )}
                                    <p className="text-xs text-slate-400 mt-1">
                                        {getRelativeTime(friend.followed_at)}に追加
                                    </p>
                                </div>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="shrink-0 text-blue-500 hover:text-blue-600 hover:bg-blue-50"
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        router.push(`/dashboard/chats?userId=${friend.id}`)
                                    }}
                                >
                                    <MessageCircle className="w-5 h-5" />
                                </Button>
                            </div>
                            {friend.line_user_tags.length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-3">
                                    {friend.line_user_tags.map(ut => (
                                        <span
                                            key={ut.tag_id}
                                            className="px-2 py-0.5 text-xs rounded-full text-white"
                                            style={{ backgroundColor: ut.tags.color }}
                                        >
                                            {ut.tags.name}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                ))}
            </div>

            {filteredFriends.length === 0 && (
                <div className="text-center py-12 text-slate-500">
                    {searchQuery || selectedTagFilter
                        ? '検索条件に一致する友だちがいません'
                        : '友だちがまだいません'}
                </div>
            )}

            {/* 詳細モーダル */}
            {selectedFriend && (
                <FriendDetailModal
                    friend={selectedFriend}
                    tags={tags}
                    onClose={() => setSelectedFriend(null)}
                    onUpdate={() => currentChannelId && fetchData(currentChannelId)}
                />
            )}

            {showImportModal && currentChannelId && (
                <ImportFriendsModal
                    channelId={currentChannelId}
                    onClose={() => setShowImportModal(false)}
                    onSuccess={() => {
                        setShowImportModal(false)
                        fetchData(currentChannelId)
                    }}
                />
            )}
        </div>
    )
}

interface ImportFriendsModalProps {
    channelId: string
    onClose: () => void
    onSuccess: () => void
}


function ImportFriendsModal({ channelId, onClose, onSuccess }: ImportFriendsModalProps) {
    const [mode, setMode] = useState<'standard' | 'lmessage'>('standard')
    const [file, setFile] = useState<File | null>(null)
    const [preview, setPreview] = useState<any[]>([])
    const [parseError, setParseError] = useState<string | null>(null)
    const [uploading, setUploading] = useState(false)
    const [result, setResult] = useState<{ success: number; failure: number } | null>(null)


    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const selectedFile = e.target.files?.[0]
        if (!selectedFile) return

        setFile(selectedFile)
        setParseError(null)
        setResult(null)

        if (mode === 'lmessage') {
            // LMessage mode: No preview parsing on client (Shift-JIS issue)
            // Just show filename and ready state
            return
        }

        Papa.parse(selectedFile, {
            header: true,
            skipEmptyLines: true,
            complete: (results) => {
                if (results.errors.length > 0) {
                    setParseError('CSVの解析に失敗しました: ' + results.errors[0].message)
                    return
                }

                // カラムチェック
                const headers = results.meta.fields || []
                const required = ['lineUserId'] // 最低限必須
                const missing = required.filter(h => !headers.includes(h))

                if (missing.length > 0) {
                    setParseError(`必須カラムが見つかりません: ${missing.join(', ')}`)
                    return
                }

                setPreview(results.data.slice(0, 5))
            },
            error: (error) => {
                setParseError('CSVの読み込みに失敗しました: ' + error.message)
            }
        })
    }


    const handleImport = async () => {
        if (!file) return

        setUploading(true)

        try {
            if (mode === 'lmessage') {
                // LMessage Import (Backend Processing)
                const formData = new FormData()
                formData.append('file', file)
                formData.append('channelId', channelId)

                const response = await fetch('/api/import/lmessage', {
                    method: 'POST',
                    body: formData,
                })

                const data = await response.json()

                if (!response.ok) {
                    throw new Error(data.error || 'インポートに失敗しました')
                }

                setResult({
                    success: data.processed,
                    failure: data.failed
                })

                setTimeout(() => {
                    onSuccess()
                }, 2000)

            } else {
                // Standard Import (Frontend Parsing)
                Papa.parse(file, {
                    header: true,
                    skipEmptyLines: true,
                    complete: async (results) => {
                        try {
                            const response = await fetch('/api/friends/import', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    channelId,
                                    data: results.data
                                }),
                            })

                            const data = await response.json()

                            if (!response.ok) {
                                throw new Error(data.error || 'インポートに失敗しました')
                            }

                            setResult({
                                success: data.processed,
                                failure: 0
                            })

                            setTimeout(() => {
                                onSuccess()
                            }, 2000)

                        } catch (error: any) {
                            setParseError(error.message)
                        }
                    }
                })
            }
        } catch (error: any) {
            setParseError(error.message)
        } finally {
            if (mode === 'lmessage') setUploading(false) // Standard mode handles loading inside complete callback
        }
    }


    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
            <Card className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto">
                <CardHeader className="flex flex-row items-start justify-between">
                    <div>
                        <CardTitle>CSVインポート</CardTitle>
                        <p className="text-sm text-slate-500 mt-1">
                            LINEユーザーを一括登録・更新します
                        </p>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg">
                        <X className="w-5 h-5" />
                    </button>
                </CardHeader>
                <CardContent className="space-y-6">
                    {/* Mode Selection */}
                    <div className="flex p-1 bg-slate-100 rounded-lg">
                        <button
                            className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${mode === 'standard' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-900'}`}
                            onClick={() => { setMode('standard'); setFile(null); setParseError(null); setResult(null); }}
                        >
                            標準CSV
                        </button>
                        <button
                            className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${mode === 'lmessage' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-900'}`}
                            onClick={() => { setMode('lmessage'); setFile(null); setParseError(null); setResult(null); }}
                        >
                            LMessage形式 (Shift-JIS)
                        </button>
                    </div>

                    {!result ? (
                        <>

                            <div className="p-4 border-2 border-dashed border-slate-200 rounded-xl bg-slate-50 text-center">
                                <input
                                    type="file"
                                    accept=".csv"
                                    onChange={handleFileChange}
                                    className="hidden"
                                    id="csv-upload"
                                />
                                <label
                                    htmlFor="csv-upload"
                                    className="cursor-pointer flex flex-col items-center gap-2 py-8"
                                >
                                    <div className="w-12 h-12 bg-emerald-100 rounded-full flex items-center justify-center text-emerald-600">
                                        <Upload className="w-6 h-6" />
                                    </div>
                                    <p className="font-medium">CSVファイルを選択</p>
                                    <p className="text-sm text-slate-500">
                                        またはここにドラッグ＆ドロップ
                                    </p>
                                </label>
                                {file && (
                                    <div className="mt-4 p-2 bg-white rounded border border-slate-200 flex items-center justify-center gap-2">
                                        <FileText className="w-4 h-4 text-slate-400" />
                                        <span className="text-sm">{file.name}</span>
                                    </div>
                                )}
                            </div>

                            {parseError && (
                                <div className="p-3 bg-red-50 text-red-600 text-sm rounded-lg flex items-center gap-2">
                                    <AlertCircle className="w-4 h-4" />
                                    {parseError}
                                </div>
                            )}

                            {preview.length > 0 && mode === 'standard' && (
                                <div className="space-y-2">

                                    <p className="text-sm font-medium">プレビュー（最初の5件）</p>
                                    <div className="overflow-x-auto border border-slate-200 rounded-lg">
                                        <table className="w-full text-sm text-left">
                                            <thead className="bg-slate-50 text-slate-500">
                                                <tr>
                                                    {Object.keys(preview[0]).map(header => (
                                                        <th key={header} className="px-3 py-2 font-medium">{header}</th>
                                                    ))}
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {preview.map((row, i) => (
                                                    <tr key={i} className="border-t border-slate-200">
                                                        {Object.values(row).map((cell: any, j) => (
                                                            <td key={j} className="px-3 py-2 max-w-[200px] truncate">
                                                                {String(cell)}
                                                            </td>
                                                        ))}
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                    <div className="p-3 bg-blue-50 text-blue-700 text-sm rounded-lg">
                                        <p className="font-medium mb-1">CSVフォーマット仕様:</p>
                                        <ul className="list-disc list-inside space-y-0.5 ml-1">
                                            <li>必須カラム: <code className="bg-blue-100 px-1 rounded">lineUserId</code></li>
                                            <li>任意カラム: <code className="bg-blue-100 px-1 rounded">displayName</code>, <code className="bg-blue-100 px-1 rounded">tags</code> (カンマ区切り)</li>
                                        </ul>
                                    </div>
                                </div>
                            )}

                            {mode === 'lmessage' && (
                                <div className="p-3 bg-blue-50 text-blue-700 text-sm rounded-lg">
                                    <p className="font-medium mb-1">仕様:</p>
                                    <ul className="list-disc list-inside space-y-0.5 ml-1">
                                        <li>LMessageのエクスポートCSV (Shift-JIS) に対応</li>
                                        <li>2行目のヘッダー「タグ_〇〇」を自動解析してタグ付けします</li>
                                        <li>「システム表示名」を管理用ネームとして登録します</li>
                                    </ul>
                                </div>
                            )}

                            <div className="flex justify-end gap-3">
                                <Button variant="outline" onClick={onClose}>キャンセル</Button>
                                <Button
                                    onClick={handleImport}
                                    disabled={!file || !!parseError || uploading}
                                    className="bg-emerald-500 hover:bg-emerald-600"
                                >
                                    {uploading && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
                                    インポート実行
                                </Button>
                            </div>
                        </>
                    ) : (
                        <div className="text-center py-12">
                            <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center text-emerald-600 mx-auto mb-4">
                                <Check className="w-8 h-8" />
                            </div>
                            <h3 className="text-xl font-bold text-slate-900">インポート完了</h3>
                            <p className="text-slate-500 mt-2">
                                {result.success}件のデータを処理しました
                            </p>
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}

interface FriendDetailModalProps {
    friend: LineUserWithTags
    tags: Tag[]
    onClose: () => void
    onUpdate: () => void
}

function FriendDetailModal({ friend, tags, onClose, onUpdate }: FriendDetailModalProps) {
    const router = useRouter()
    const [internalName, setInternalName] = useState(friend.internal_name || '')
    const [saving, setSaving] = useState(false)
    const [deleting, setDeleting] = useState(false)


    const [tagLoading, setTagLoading] = useState<string | null>(null)
    // Local state for optimistic UI updates
    const [localTagIds, setLocalTagIds] = useState<string[]>(friend.line_user_tags.map(ut => ut.tag_id))


    // Update local state when friend prop changes (e.g. after parent re-fetch)
    useEffect(() => {
        setLocalTagIds(friend.line_user_tags.map(ut => ut.tag_id))
    }, [friend])

    const handleSaveName = async () => {
        setSaving(true)
        const supabase = createClient()

        await supabase
            .from('line_users')
            .update({ internal_name: internalName })
            .eq('id', friend.id)

        setSaving(false)
        onUpdate()
    }

    const handleToggleTag = async (tagId: string) => {
        setTagLoading(tagId)
        const hasTag = localTagIds.includes(tagId)

        // Optimistic Update
        setLocalTagIds(prev =>
            hasTag ? prev.filter(id => id !== tagId) : [...prev, tagId]
        )

        try {
            const response = await fetch('/api/tags/assign', {
                method: hasTag ? 'DELETE' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    lineUserId: friend.id,
                    tagId,
                }),
            })

            if (response.ok) {
                onUpdate()
            } else {
                // Revert on failure
                setLocalTagIds(prev =>
                    hasTag ? [...prev, tagId] : prev.filter(id => id !== tagId)
                )
                console.error('Failed to update tags')
            }
        } catch (error) {
            console.error('タグ操作エラー:', error)
            // Revert on error
            setLocalTagIds(prev =>
                hasTag ? [...prev, tagId] : prev.filter(id => id !== tagId)
            )
        }

        setTagLoading(null)
    }

    const handleDelete = async () => {
        if (!confirm('本当にこの友だちを削除しますか？\n\n・チャット履歴\n・タグ情報\n・ステップ配信状況\n\nこれら全ての関連データも削除され、元に戻すことはできません。')) {
            return
        }

        setDeleting(true)
        try {
            const res = await fetch(`/api/friends/${friend.id}`, {
                method: 'DELETE',
            })

            if (!res.ok) {
                const data = await res.json()
                throw new Error(data.error || '削除失敗')
            }

            onClose()
            onUpdate()
            alert('削除しました')
        } catch (error: any) {
            alert(error.message)
        } finally {
            setDeleting(false)
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
            <Card className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto">
                <CardHeader className="flex flex-row items-start justify-between">
                    <div className="flex items-center gap-4">
                        {friend.picture_url ? (
                            <img
                                src={friend.picture_url}
                                alt={friend.display_name || ''}
                                className="w-16 h-16 rounded-full object-cover"
                            />
                        ) : (
                            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-slate-200 to-slate-300 flex items-center justify-center">
                                <User className="w-8 h-8 text-slate-500" />
                            </div>
                        )}
                        <div>
                            <CardTitle>{friend.display_name || '名前なし'}</CardTitle>
                            <p className="text-sm text-slate-500">
                                {formatDateTime(friend.followed_at)}に追加
                            </p>
                        </div>
                    </div>
                    <div className="flex gap-2">
                        <Button
                            variant="outline"
                            className="text-blue-600 border-blue-200 hover:bg-blue-50"
                            onClick={() => router.push(`/dashboard/chats?userId=${friend.id}`)}
                        >
                            <MessageCircle className="w-4 h-4 mr-2" />
                            チャットを開く
                        </Button>
                        <button
                            onClick={onClose}
                            className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                </CardHeader>
                <CardContent className="space-y-6">
                    {/* 管理用ネーム */}
                    <div className="space-y-2">
                        <label className="text-sm font-medium">管理用ネーム（社内管理用）</label>
                        <p className="text-xs text-slate-500">
                            ※この名前はLINE上には表示されません。管理画面内での呼び名として使用できます。
                        </p>
                        <div className="flex gap-2">
                            <Input
                                value={internalName}
                                onChange={(e) => setInternalName(e.target.value)}
                                placeholder="例: 山田 花子（VIP会員）"
                            />
                            <Button onClick={handleSaveName} disabled={saving}>
                                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                            </Button>
                        </div>
                    </div>

                    {/* タグ */}
                    <div className="space-y-2">
                        <label className="text-sm font-medium flex items-center gap-2">
                            <TagIcon className="w-4 h-4" />
                            タグ
                        </label>
                        <div className="flex flex-wrap gap-2">
                            {tags.map(tag => {
                                const hasTag = localTagIds.includes(tag.id)
                                const isLoading = tagLoading === tag.id
                                return (
                                    <button
                                        key={tag.id}
                                        onClick={() => handleToggleTag(tag.id)}
                                        disabled={isLoading}
                                        className={cn(
                                            "px-3 py-1.5 rounded-full text-sm font-medium transition-all duration-200",
                                            hasTag
                                                ? "text-white shadow-lg"
                                                : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300"
                                        )}
                                        style={hasTag ? { backgroundColor: tag.color } : {}}
                                    >
                                        {isLoading ? (
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                        ) : (
                                            <>
                                                {hasTag && <Check className="w-3 h-3 inline mr-1" />}
                                                {tag.name}
                                            </>
                                        )}
                                    </button>
                                )
                            })}
                        </div>
                        {tags.length === 0 && (
                            <p className="text-sm text-slate-500">
                                タグがまだありません。タグ管理から作成してください。
                            </p>
                        )}
                    </div>

                    {/* ステータスメッセージ */}
                    {friend.status_message && (
                        <div className="space-y-2">
                            <label className="text-sm font-medium">ステータスメッセージ</label>
                            <p className="text-sm text-slate-600 dark:text-slate-400 p-3 bg-slate-50 dark:bg-slate-800 rounded-lg">
                                {friend.status_message}
                            </p>
                        </div>
                    )}
                </CardContent>

                {/* フッター：削除ボタン */}
                <div className="p-4 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 flex justify-end">
                    <Button
                        variant="ghost"
                        className="text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                        onClick={handleDelete}
                        disabled={saving || deleting}
                    >
                        {deleting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Trash2 className="w-4 h-4 mr-2" />}
                        この友だちを削除
                    </Button>
                </div>
            </Card>
        </div>
    )
}
