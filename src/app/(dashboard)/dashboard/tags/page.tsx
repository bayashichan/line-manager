'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button, Input, Label, Card, CardHeader, CardTitle, CardContent } from '@/components/ui'
import { cn, getCookie } from '@/lib/utils'
import type { Tag, RichMenu } from '@/types'
import {
    Plus,
    Edit2,
    Trash2,
    Save,
    X,
    Loader2,
    LayoutGrid,
    ArrowUpDown,
} from 'lucide-react'

interface TagWithRichMenu extends Tag {
    rich_menus: RichMenu | null
}

const TAG_COLORS = [
    '#3B82F6', // blue
    '#10B981', // emerald
    '#8B5CF6', // violet
    '#F59E0B', // amber
    '#EF4444', // red
    '#EC4899', // pink
    '#06B6D4', // cyan
    '#84CC16', // lime
    '#6366F1', // indigo
    '#F97316', // orange
]

export default function TagsPage() {
    const [tags, setTags] = useState<TagWithRichMenu[]>([])
    const [richMenus, setRichMenus] = useState<RichMenu[]>([])
    const [loading, setLoading] = useState(true)
    const [currentChannelId, setCurrentChannelId] = useState<string | null>(null)
    const [editingTag, setEditingTag] = useState<TagWithRichMenu | null>(null)
    const [isCreating, setIsCreating] = useState(false)
    const [saving, setSaving] = useState(false)

    // 新規作成/編集フォーム
    const [formName, setFormName] = useState('')
    const [formColor, setFormColor] = useState(TAG_COLORS[0])
    const [formRichMenuId, setFormRichMenuId] = useState<string | null>(null)
    const [formPriority, setFormPriority] = useState(0)

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

        // タグ一覧取得
        const { data: tagsData } = await supabase
            .from('tags')
            .select(`
        *,
        rich_menus (*)
      `)
            .eq('channel_id', channelId)
            .order('priority', { ascending: false })
            .order('name')

        if (tagsData) {
            setTags(tagsData as TagWithRichMenu[])
        }

        // リッチメニュー一覧取得
        const { data: richMenusData } = await supabase
            .from('rich_menus')
            .select('*')
            .eq('channel_id', channelId)
            .eq('is_active', true)
            .order('name')

        if (richMenusData) {
            setRichMenus(richMenusData)
        }
    }

    const resetForm = () => {
        setFormName('')
        setFormColor(TAG_COLORS[0])
        setFormRichMenuId(null)
        setFormPriority(0)
        setEditingTag(null)
        setIsCreating(false)
    }

    const startEditing = (tag: TagWithRichMenu) => {
        setEditingTag(tag)
        setFormName(tag.name)
        setFormColor(tag.color)
        setFormRichMenuId(tag.linked_rich_menu_id)
        setFormPriority(tag.priority)
        setIsCreating(false)
    }

    const startCreating = () => {
        resetForm()
        setIsCreating(true)
    }

    const handleSave = async () => {
        if (!formName.trim() || !currentChannelId) return

        setSaving(true)

        try {
            if (editingTag) {
                // 更新
                await fetch('/api/tags', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        id: editingTag.id,
                        name: formName,
                        color: formColor,
                        linkedRichMenuId: formRichMenuId,
                        priority: formPriority,
                    }),
                })
            } else {
                // 新規作成
                await fetch('/api/tags', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        channelId: currentChannelId,
                        name: formName,
                        color: formColor,
                        linkedRichMenuId: formRichMenuId,
                        priority: formPriority,
                    }),
                })
            }

            await fetchData(currentChannelId)
            resetForm()
        } catch (error) {
            console.error('保存エラー:', error)
        }

        setSaving(false)
    }

    const handleDelete = async (tagId: string) => {
        if (!confirm('このタグを削除しますか？')) return

        try {
            await fetch(`/api/tags?id=${tagId}`, { method: 'DELETE' })
            if (currentChannelId) {
                await fetchData(currentChannelId)
            }
        } catch (error) {
            console.error('削除エラー:', error)
        }
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
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold bg-gradient-to-r from-slate-900 to-slate-700 bg-clip-text text-transparent dark:from-slate-100 dark:to-slate-300">
                        タグ管理
                    </h1>
                    <p className="text-slate-500 dark:text-slate-400 mt-1">
                        {tags.length}個のタグ
                    </p>
                </div>
                <Button onClick={startCreating}>
                    <Plus className="w-4 h-4" />
                    タグを追加
                </Button>
            </div>

            {/* 作成/編集フォーム */}
            {(isCreating || editingTag) && (
                <Card>
                    <CardHeader>
                        <CardTitle>{editingTag ? 'タグを編集' : '新しいタグ'}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="grid gap-4 sm:grid-cols-2">
                            <div className="space-y-2">
                                <Label>タグ名</Label>
                                <Input
                                    value={formName}
                                    onChange={(e) => setFormName(e.target.value)}
                                    placeholder="例: VIP会員"
                                />
                            </div>
                            <div className="space-y-2">
                                <Label>優先度</Label>
                                <Input
                                    type="number"
                                    value={formPriority}
                                    onChange={(e) => setFormPriority(parseInt(e.target.value) || 0)}
                                    placeholder="0"
                                />
                                <p className="text-xs text-slate-500">
                                    数字が大きいほど優先（リッチメニュー切替時）
                                </p>
                            </div>
                        </div>

                        <div className="space-y-2">
                            <Label>カラー</Label>
                            <div className="flex flex-wrap gap-2">
                                {TAG_COLORS.map(color => (
                                    <button
                                        key={color}
                                        onClick={() => setFormColor(color)}
                                        className={cn(
                                            "w-8 h-8 rounded-full transition-all duration-200",
                                            formColor === color && "ring-2 ring-offset-2 ring-slate-400 scale-110"
                                        )}
                                        style={{ backgroundColor: color }}
                                    />
                                ))}
                            </div>
                        </div>

                        <div className="space-y-2">
                            <Label className="flex items-center gap-2">
                                <LayoutGrid className="w-4 h-4" />
                                連動リッチメニュー
                            </Label>
                            <select
                                value={formRichMenuId || ''}
                                onChange={(e) => setFormRichMenuId(e.target.value || null)}
                                className="w-full h-10 px-3 rounded-lg border border-slate-200 bg-white/50 backdrop-blur-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-slate-700 dark:bg-slate-800/50"
                            >
                                <option value="">連動なし</option>
                                {richMenus.map(menu => (
                                    <option key={menu.id} value={menu.id}>
                                        {menu.name}
                                    </option>
                                ))}
                            </select>
                            <p className="text-xs text-slate-500">
                                このタグが付与されると、自動的にこのリッチメニューに切り替わります
                            </p>
                        </div>

                        <div className="flex gap-2 justify-end">
                            <Button variant="outline" onClick={resetForm}>
                                キャンセル
                            </Button>
                            <Button onClick={handleSave} disabled={saving || !formName.trim()}>
                                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                                <Save className="w-4 h-4" />
                                保存
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* タグ一覧 */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {tags.map(tag => (
                    <Card key={tag.id} className="hover:shadow-lg transition-all duration-200">
                        <CardContent className="p-4">
                            <div className="flex items-start justify-between">
                                <div className="flex items-center gap-3">
                                    <div
                                        className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold"
                                        style={{ backgroundColor: tag.color }}
                                    >
                                        {tag.name[0]}
                                    </div>
                                    <div>
                                        <h3 className="font-medium">{tag.name}</h3>
                                        <div className="flex items-center gap-2 text-xs text-slate-500">
                                            <ArrowUpDown className="w-3 h-3" />
                                            優先度: {tag.priority}
                                        </div>
                                    </div>
                                </div>
                                <div className="flex gap-1">
                                    <button
                                        onClick={() => startEditing(tag)}
                                        className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
                                    >
                                        <Edit2 className="w-4 h-4" />
                                    </button>
                                    <button
                                        onClick={() => handleDelete(tag.id)}
                                        className="p-2 hover:bg-red-50 text-red-500 rounded-lg transition-colors"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>
                            {tag.rich_menus && (
                                <div className="mt-3 p-2 bg-slate-50 dark:bg-slate-800 rounded-lg flex items-center gap-2">
                                    <LayoutGrid className="w-4 h-4 text-emerald-500" />
                                    <span className="text-sm text-slate-600 dark:text-slate-400">
                                        {tag.rich_menus.name}
                                    </span>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                ))}
            </div>

            {tags.length === 0 && !isCreating && (
                <div className="text-center py-12">
                    <div className="w-16 h-16 mx-auto mb-4 bg-slate-100 dark:bg-slate-800 rounded-full flex items-center justify-center">
                        <Plus className="w-8 h-8 text-slate-400" />
                    </div>
                    <p className="text-slate-500 mb-4">
                        タグがまだありません
                    </p>
                    <Button onClick={startCreating}>
                        最初のタグを作成
                    </Button>
                </div>
            )}
        </div>
    )
}
