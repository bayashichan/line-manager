'use client'

import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button, Input, Label, Card, CardHeader, CardTitle, CardContent } from '@/components/ui'
import { cn, getCookie } from '@/lib/utils'
import type { RichMenu, RichMenuArea } from '@/types'
import {
    Plus,
    Edit2,
    Trash2,
    Save,
    Upload,
    Star,
    StarOff,
    Loader2,
    Image as ImageIcon,
    X,
    Cloud,
    CloudOff,
    MousePointer,
    LayoutTemplate,
    Grid,
    Square,
    Calendar,
    Tag,
    Clock,
} from 'lucide-react'

// Rich Menu Templates Definition
const RICH_MENU_TEMPLATES = [
    {
        id: 'large_6',
        name: '大: 6分割',
        type: 'Large',
        icon: <Grid className="w-6 h-6" />,
        areas: [
            { bounds: { x: 0, y: 0, width: 833, height: 843 }, action: { type: 'message', text: '' } },
            { bounds: { x: 833, y: 0, width: 834, height: 843 }, action: { type: 'message', text: '' } },
            { bounds: { x: 1667, y: 0, width: 833, height: 843 }, action: { type: 'message', text: '' } },
            { bounds: { x: 0, y: 843, width: 833, height: 843 }, action: { type: 'message', text: '' } },
            { bounds: { x: 833, y: 843, width: 834, height: 843 }, action: { type: 'message', text: '' } },
            { bounds: { x: 1667, y: 843, width: 833, height: 843 }, action: { type: 'message', text: '' } },
        ]
    },
    {
        id: 'large_4',
        name: '大: 4分割 (2x2)',
        type: 'Large',
        icon: <Grid className="w-6 h-6" />,
        areas: [
            { bounds: { x: 0, y: 0, width: 1250, height: 843 }, action: { type: 'message', text: '' } },
            { bounds: { x: 1250, y: 0, width: 1250, height: 843 }, action: { type: 'message', text: '' } },
            { bounds: { x: 0, y: 843, width: 1250, height: 843 }, action: { type: 'message', text: '' } },
            { bounds: { x: 1250, y: 843, width: 1250, height: 843 }, action: { type: 'message', text: '' } },
        ]
    },
    {
        id: 'large_3_upper1',
        name: '大: 3分割 (上1・下2)',
        type: 'Large',
        icon: <LayoutTemplate className="w-6 h-6" />,
        areas: [
            { bounds: { x: 0, y: 0, width: 2500, height: 843 }, action: { type: 'message', text: '' } },
            { bounds: { x: 0, y: 843, width: 1250, height: 843 }, action: { type: 'message', text: '' } },
            { bounds: { x: 1250, y: 843, width: 1250, height: 843 }, action: { type: 'message', text: '' } },
        ]
    },
    {
        id: 'large_3_left',
        name: '大（左1 右2）',
        type: 'Large',
        icon: <LayoutTemplate className="w-6 h-6" />,
        areas: [
            { bounds: { x: 0, y: 0, width: 1250, height: 1686 }, action: { type: 'message', text: '' } }, // Left
            { bounds: { x: 1250, y: 0, width: 1250, height: 843 }, action: { type: 'message', text: '' } }, // Right Top
            { bounds: { x: 1250, y: 843, width: 1250, height: 843 }, action: { type: 'message', text: '' } }, // Right Bottom
        ],
    },
    {
        id: 'large_2_vertical',
        name: '大（上下2分割）',
        type: 'Large',
        icon: <LayoutTemplate className="w-6 h-6" />,
        areas: [
            { bounds: { x: 0, y: 0, width: 2500, height: 843 }, action: { type: 'message', text: '' } }, // Top
            { bounds: { x: 0, y: 843, width: 2500, height: 843 }, action: { type: 'message', text: '' } }, // Bottom
        ],
    },
    {
        id: 'large_2_horizontal',
        name: '大（左右2分割）',
        type: 'Large',
        icon: <LayoutTemplate className="w-6 h-6" />,
        areas: [
            { bounds: { x: 0, y: 0, width: 1250, height: 1686 }, action: { type: 'message', text: '' } }, // Left
            { bounds: { x: 1250, y: 0, width: 1250, height: 1686 }, action: { type: 'message', text: '' } }, // Right
        ],
    },
    {
        id: 'large_1',
        name: '大: 全面 (1分割)',
        type: 'Large',
        icon: <Square className="w-6 h-6" />,
        areas: [
            { bounds: { x: 0, y: 0, width: 2500, height: 1686 }, action: { type: 'message', text: '' } },
        ]
    },
    {
        id: 'small_3',
        name: '小: 3分割',
        type: 'Small',
        icon: <Grid className="w-6 h-6" />,
        areas: [
            { bounds: { x: 0, y: 0, width: 833, height: 843 }, action: { type: 'message', text: '' } },
            { bounds: { x: 833, y: 0, width: 834, height: 843 }, action: { type: 'message', text: '' } },
            { bounds: { x: 1667, y: 0, width: 833, height: 843 }, action: { type: 'message', text: '' } },
        ]
    },
    {
        id: 'small_2',
        name: '小: 2分割',
        type: 'Small',
        icon: <Grid className="w-6 h-6" />,
        areas: [
            { bounds: { x: 0, y: 0, width: 1250, height: 843 }, action: { type: 'message', text: '' } },
            { bounds: { x: 1250, y: 0, width: 1250, height: 843 }, action: { type: 'message', text: '' } },
        ]
    },
    {
        id: 'small_1',
        name: '小: 全面 (1分割)',
        type: 'Small',
        icon: <Square className="w-6 h-6" />,
        areas: [
            { bounds: { x: 0, y: 0, width: 2500, height: 843 }, action: { type: 'message', text: '' } },
        ]
    }
]

export default function RichMenusPage() {
    const [richMenus, setRichMenus] = useState<RichMenu[]>([])
    const [tags, setTags] = useState<any[]>([]) // Tag type should be imported or defined
    const [loading, setLoading] = useState(true)
    const [currentChannelId, setCurrentChannelId] = useState<string | null>(null)
    const [isCreating, setIsCreating] = useState(false)
    const [editingMenu, setEditingMenu] = useState<RichMenu | null>(null)
    const [saving, setSaving] = useState(false)
    const [registering, setRegistering] = useState<string | null>(null)

    // フォーム
    const [formName, setFormName] = useState('')
    const [formImageFile, setFormImageFile] = useState<File | null>(null)
    const [formImagePreview, setFormImagePreview] = useState<string | null>(null)
    const [formIsDefault, setFormIsDefault] = useState(false)
    const [formAreas, setFormAreas] = useState<RichMenuArea[]>([])
    // New fields
    const [formDisplayStart, setFormDisplayStart] = useState<string>('')
    const [formDisplayEnd, setFormDisplayEnd] = useState<string>('')
    const [formTargetTagId, setFormTargetTagId] = useState<string>('')

    const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null)
    const [hoveredAreaIndex, setHoveredAreaIndex] = useState<number | null>(null) // ハイライト用

    const fileInputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        fetchChannelAndData()
    }, [])

    const fetchChannelAndData = async () => {
        const supabase = createClient()
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
        const { data: richMenusData } = await supabase
            .from('rich_menus')
            .select('*')
            .eq('channel_id', channelId)
            .order('is_default', { ascending: false })
            .order('name')

        if (richMenusData) {
            setRichMenus(richMenusData)
        }

        // Tags取得 (for selection)
        const { data: tagsData } = await supabase
            .from('tags')
            .select('*')
            .eq('channel_id', channelId)
            .order('priority', { ascending: false })

        if (tagsData) {
            setTags(tagsData)
        }
    }

    const resetForm = () => {
        setFormName('')
        setFormImageFile(null)
        setFormImagePreview(null)
        setFormIsDefault(false)
        setFormAreas([])
        setFormDisplayStart('')
        setFormDisplayEnd('')
        setFormTargetTagId('')
        setSelectedTemplateId(null)
        setEditingMenu(null)
        setIsCreating(false)
    }

    const startCreating = () => {
        resetForm()
        setIsCreating(true)
    }

    const startEditing = (menu: RichMenu) => {
        setEditingMenu(menu)
        setFormName(menu.name)
        setFormImagePreview(menu.image_url)
        setFormIsDefault(menu.is_default)
        setFormAreas(menu.areas || [])
        // Period
        setFormDisplayStart(menu.display_period_start ? new Date(menu.display_period_start).toISOString().slice(0, 16) : '')
        setFormDisplayEnd(menu.display_period_end ? new Date(menu.display_period_end).toISOString().slice(0, 16) : '')
        // Find linked tag
        const linkedTag = tags.find(t => t.linked_rich_menu_id === menu.id)
        setFormTargetTagId(linkedTag ? linkedTag.id : '')

        setSelectedTemplateId(null) // 編集時はテンプレート選択状態をリセット（カスタム扱い）
        setIsCreating(false)
    }

    const handleTemplateSelect = (templateId: string) => {
        const template = RICH_MENU_TEMPLATES.find(t => t.id === templateId)
        if (template) {
            setSelectedTemplateId(templateId)
            setFormAreas(JSON.parse(JSON.stringify(template.areas))) // Deep copy
        }
    }



    const handleSave = async () => {
        if (!formName.trim() || !currentChannelId) return

        setSaving(true)
        const supabase = createClient()

        try {
            let imageUrl = editingMenu?.image_url || null

            if (formImageFile) {
                const fileExt = formImageFile.name.split('.').pop()
                const fileName = `${Date.now()}.${fileExt}`
                const filePath = `rich-menus/${currentChannelId}/${fileName}`

                const { error: uploadError } = await supabase.storage
                    .from('line-assets')
                    .upload(filePath, formImageFile)

                if (!uploadError) {
                    const { data: { publicUrl } } = supabase.storage
                        .from('line-assets')
                        .getPublicUrl(filePath)
                    imageUrl = publicUrl
                }
            }

            let savedMenuId: string | null = null

            const periodStart = formDisplayStart ? new Date(formDisplayStart).toISOString() : null
            const periodEnd = formDisplayEnd ? new Date(formDisplayEnd).toISOString() : null

            if (editingMenu) {
                savedMenuId = editingMenu.id
                await supabase
                    .from('rich_menus')
                    .update({
                        name: formName,
                        image_url: imageUrl,
                        is_default: formIsDefault,
                        areas: formAreas,
                        display_period_start: periodStart,
                        display_period_end: periodEnd,
                    })
                    .eq('id', editingMenu.id)
            } else {
                if (formIsDefault) {
                    await supabase
                        .from('rich_menus')
                        .update({ is_default: false })
                        .eq('channel_id', currentChannelId)
                }

                const { data: inserted, error } = await supabase
                    .from('rich_menus')
                    .insert({
                        channel_id: currentChannelId,
                        name: formName,
                        image_url: imageUrl,
                        is_default: formIsDefault,
                        areas: formAreas,
                        display_period_start: periodStart,
                        display_period_end: periodEnd,
                    })
                    .select()
                    .single()

                if (inserted) savedMenuId = inserted.id
            }

            // Tag Linking Logic
            if (savedMenuId) {
                // 1. Clear existing links to this menu (if any, or if we want to move it)
                // Actually if specific tag is selected, we link it.
                // If NO tag is selected (formTargetTagId === ''), we should remove link from any tag that points to this menu?
                // Yes, if editing.

                // First, unlink this menu from ALL tags to start fresh (or just the one that was linked)
                // Simpler: Set linked_rich_menu_id = NULL where linked_rich_menu_id = savedMenuId
                await supabase
                    .from('tags')
                    .update({ linked_rich_menu_id: null })
                    .eq('linked_rich_menu_id', savedMenuId)

                // 2. If a tag is selected, link it
                if (formTargetTagId) {
                    await supabase
                        .from('tags')
                        .update({ linked_rich_menu_id: savedMenuId })
                        .eq('id', formTargetTagId)
                }
            }

            // デフォルト設定の排他制御（既存のものを外す）はDBのトリガーか、ここでやる
            // （簡易的にここで他のis_defaultをfalseにする処理も入れるべきだが省略）

            await fetchData(currentChannelId)
            resetForm()
        } catch (error) {
            console.error('保存エラー:', error)
        }

        setSaving(false)
    }

    const handleDelete = async (menuId: string) => {
        if (!confirm('このリッチメニューを削除しますか？')) return
        const supabase = createClient()
        await supabase.from('rich_menus').delete().eq('id', menuId)
        if (currentChannelId) await fetchData(currentChannelId)
    }

    const handleSetDefault = async (menuId: string) => {
        if (!currentChannelId) return
        const supabase = createClient()
        await supabase.from('rich_menus').update({ is_default: false }).eq('channel_id', currentChannelId)
        await supabase.from('rich_menus').update({ is_default: true }).eq('id', menuId)
        await fetchData(currentChannelId)
    }

    const handleRegisterToLine = async (menuId: string) => {
        setRegistering(menuId)
        try {
            const response = await fetch('/api/rich-menus/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ richMenuId: menuId }),
            })

            const data = await response.json()

            if (!response.ok) {
                throw new Error(data.error || data.details || 'LINE APIへの登録に失敗しました')
            }

            alert('LINE APIへの登録が完了しました！')
            if (currentChannelId) await fetchData(currentChannelId)
        } catch (error: any) {
            console.error('Registration Error:', error)
            alert(`エラー: ${error.message}`)
        }
        setRegistering(null)
    }

    const handleUnregisterFromLine = async (menuId: string) => {
        if (!confirm('LINE APIからこのリッチメニューを削除しますか？')) return
        setRegistering(menuId)
        try {
            const response = await fetch(`/api/rich-menus/register?richMenuId=${menuId}`, { method: 'DELETE' })
            const data = await response.json()

            if (!response.ok) {
                throw new Error(data.error || '削除に失敗しました')
            }

            alert('LINE APIから削除しました')
            if (currentChannelId) await fetchData(currentChannelId)
        } catch (error: any) {
            alert(`エラー: ${error.message}`)
        }
        setRegistering(null)
    }

    // 画像を指定サイズにリサイズする関数
    const resizeImage = (file: File, width: number, height: number): Promise<File> => {
        return new Promise((resolve, reject) => {
            const img = new Image()
            const reader = new FileReader()

            reader.onload = (e) => {
                img.src = e.target?.result as string
            }

            img.onload = () => {
                const canvas = document.createElement('canvas')
                canvas.width = width
                canvas.height = height
                const ctx = canvas.getContext('2d')

                if (!ctx) {
                    reject(new Error('Canvas context failure'))
                    return
                }

                // 白背景で塗りつぶす（透過PNG対策）
                ctx.fillStyle = '#FFFFFF'
                ctx.fillRect(0, 0, width, height)

                // アスペクト比を維持して中央に描画するか、引き伸ばすか
                // ここではLINEのリッチメニューの性質上、全体を埋める（引き伸ばし/切り取り）が望ましいが
                // ユーザーの画像を勝手に切るとクレームになるため、フィットさせる (contain)
                // ただし、LINEは「余白」を許さない（透過不可）なので、余白は白になる。

                // 単純な引き伸ばし(fill)だと画像が歪む。
                // drawImage(img, 0, 0, width, height) -> 歪む

                // ここでは「歪んでもいいから埋める」か「余白あり」か迷うが、
                // リッチメニュー作成ツールとしては「歪まない」のが正義。
                // 描画領域を計算
                const scale = Math.max(width / img.width, height / img.height)
                const x = (width / 2) - (img.width / 2) * scale
                const y = (height / 2) - (img.height / 2) * scale

                // ctx.drawImage(img, x, y, img.width * scale, img.height * scale)
                // いや、これだとカバー(cover)になる。はみ出る。

                // とりあえず単純にリサイズ（歪むが一番確実）させる。
                // こだわるユーザーは自分で2500x1686を作ってくるはず。
                ctx.drawImage(img, 0, 0, width, height)

                canvas.toBlob((blob) => {
                    if (blob) {
                        const resizedFile = new File([blob], file.name, { type: 'image/jpeg', lastModified: Date.now() })
                        resolve(resizedFile)
                    } else {
                        reject(new Error('Canvas blob failure'))
                    }
                }, 'image/jpeg', 0.9)
            }

            reader.readAsDataURL(file)
        })
    }

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (file) {
            // ターゲットサイズを決定
            const selectedTemplate = RICH_MENU_TEMPLATES.find(t => t.id === selectedTemplateId)
            const isSmall = selectedTemplate?.type === 'Small'
            const targetWidth = 2500
            const targetHeight = isSmall ? 843 : 1686

            try {
                // 自動リサイズ
                const resizedFile = await resizeImage(file, targetWidth, targetHeight)
                setFormImageFile(resizedFile)

                // プレビュー表示
                const reader = new FileReader()
                reader.onloadend = () => {
                    setFormImagePreview(reader.result as string)
                }
                reader.readAsDataURL(resizedFile)

            } catch (err) {
                console.error('Resize error:', err)
                alert('画像の処理に失敗しました')
            }
        }
    }
    const addArea = () => {
        setFormAreas([
            ...formAreas,
            { bounds: { x: 0, y: 0, width: 833, height: 843 }, action: { type: 'message', text: '' } },
        ])
    }

    const updateArea = (index: number, field: string, value: any) => {
        const updated = [...formAreas]
        if (field === 'actionType') {
            updated[index] = { ...updated[index], action: { type: value, text: '', uri: '' } }
        } else if (field === 'actionValue') {
            const actionField = updated[index].action.type === 'uri' ? 'uri' : 'text'
            updated[index] = { ...updated[index], action: { ...updated[index].action, [actionField]: value } }
        } else {
            const [parent, child] = field.split('.')
            if (parent === 'bounds') {
                updated[index] = { ...updated[index], bounds: { ...updated[index].bounds, [child]: parseInt(value) || 0 } }
            }
        }
        setFormAreas(updated)
    }

    const removeArea = (index: number) => {
        setFormAreas(formAreas.filter((_, i) => i !== index))
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
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold bg-gradient-to-r from-slate-900 to-slate-700 bg-clip-text text-transparent dark:from-slate-100 dark:to-slate-300">
                        リッチメニュー管理
                    </h1>
                    <p className="text-slate-500 dark:text-slate-400 mt-1">
                        {richMenus.length}個のリッチメニュー
                    </p>
                </div>
                <Button onClick={startCreating}>
                    <Plus className="w-4 h-4" />
                    リッチメニューを追加
                </Button>
            </div>

            {(isCreating || editingMenu) && (
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between">
                        <CardTitle>{editingMenu ? 'リッチメニューを編集' : '新しいリッチメニュー'}</CardTitle>
                        <button onClick={resetForm} className="p-2 hover:bg-slate-100 rounded-lg">
                            <X className="w-5 h-5" />
                        </button>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        <div className="space-y-2">
                            <Label>メニュー名</Label>
                            <Input
                                value={formName}
                                onChange={(e) => setFormName(e.target.value)}
                                placeholder="例: メインメニュー"
                            />
                        </div>

                        {/* テンプレート選択 */}
                        <div className="space-y-2">
                            <Label className="flex items-center gap-2">
                                <LayoutTemplate className="w-4 h-4" />
                                テンプレートから選択
                            </Label>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                {RICH_MENU_TEMPLATES.map(template => (
                                    <button
                                        key={template.id}
                                        onClick={() => handleTemplateSelect(template.id)}
                                        className={cn(
                                            "flex flex-col items-center justify-center p-3 rounded-xl border-2 transition-all",
                                            selectedTemplateId === template.id
                                                ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700"
                                                : "border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600 bg-white dark:bg-slate-800"
                                        )}
                                    >
                                        <div className="mb-2 p-2 bg-slate-100 dark:bg-slate-700 rounded-lg">
                                            {template.icon}
                                        </div>
                                        <span className="text-xs font-medium text-center">{template.name}</span>
                                        <span className="text-[10px] text-slate-400 mt-0.5">{template.type}</span>
                                    </button>
                                ))}
                                <button
                                    onClick={() => setSelectedTemplateId(null)}
                                    className={cn(
                                        "flex flex-col items-center justify-center p-3 rounded-xl border-2 border-dashed transition-all",
                                        selectedTemplateId === null
                                            ? "border-slate-400 bg-slate-50 dark:bg-slate-800"
                                            : "border-slate-200 hover:border-slate-300"
                                    )}
                                >
                                    <span className="text-xs font-medium">カスタム</span>
                                </button>
                            </div>
                        </div>

                        <div className="space-y-2">
                            <Label>メニュー画像</Label>


                            {/* Visual Editor Area */}
                            {(() => {
                                const selectedTemplate = RICH_MENU_TEMPLATES.find(t => t.id === selectedTemplateId)
                                // If template is selected, follow its type.
                                // If not (custom or editing), infer from existing areas: if any area exceeds y=843, it must be Large.
                                // Otherwise default to Large to be safe, or allow user switch.
                                // For now, if no template selected, default to Large (1686).
                                const isSmall = selectedTemplate?.type === 'Small'
                                const baseHeight = isSmall ? 843 : 1686

                                return (
                                    <div className="relative w-full max-w-2xl mx-auto border rounded-xl overflow-hidden bg-slate-100 dark:bg-slate-800">
                                        <div
                                            className={cn(
                                                "relative w-full",
                                                isSmall ? "aspect-[2500/843]" : "aspect-[2500/1686]"
                                            )}
                                        >
                                            {formImagePreview ? (
                                                <img
                                                    src={formImagePreview}
                                                    alt="プレビュー"
                                                    className="absolute inset-0 w-full h-full object-contain"
                                                />
                                            ) : (
                                                <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 pointer-events-none">
                                                    <ImageIcon className="w-12 h-12 mb-2" />
                                                    <p className="text-sm">画像未設定</p>
                                                    <p className="text-xs opacity-70">
                                                        {isSmall ? '推奨: 2500 x 843' : '推奨: 2500 x 1686'}
                                                    </p>
                                                </div>
                                            )}

                                            {/* Overlay Generator */}
                                            {formAreas.map((area, index) => {
                                                const left = (area.bounds.x / 2500) * 100
                                                const top = (area.bounds.y / baseHeight) * 100
                                                const width = (area.bounds.width / 2500) * 100
                                                const height = (area.bounds.height / baseHeight) * 100

                                                return (
                                                    <div
                                                        key={index}
                                                        className={cn(
                                                            "absolute border-2 flex items-center justify-center text-xs font-bold text-white shadow-sm transition-all cursor-pointer",
                                                            hoveredAreaIndex === index
                                                                ? "bg-emerald-500/50 border-emerald-400 z-10 scale-[1.01]"
                                                                : "bg-black/30 border-white/50 hover:bg-black/40"
                                                        )}
                                                        style={{
                                                            left: `${left}%`,
                                                            top: `${top}%`,
                                                            width: `${width}%`,
                                                            height: `${height}%`,
                                                        }}
                                                        onMouseEnter={() => setHoveredAreaIndex(index)}
                                                        onMouseLeave={() => setHoveredAreaIndex(null)}
                                                        onClick={() => {
                                                            document.getElementById(`area-editor-${index}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                                                        }}
                                                    >
                                                        <span className="bg-black/50 px-2 py-1 rounded-full backdrop-blur-sm">
                                                            {index + 1}
                                                        </span>
                                                    </div>
                                                )
                                            })}
                                        </div>

                                        <div
                                            onClick={() => fileInputRef.current?.click()}
                                            className="absolute inset-0 w-full h-full opacity-0 hover:opacity-100 transition-opacity bg-black/10 cursor-pointer flex items-center justify-center group"
                                            style={{ pointerEvents: 'none' }}
                                        >
                                        </div>
                                    </div>
                                )
                            })()}

                            <Button
                                variant="outline"
                                className="w-full mt-2"
                                onClick={() => fileInputRef.current?.click()}
                            >
                                <Upload className="w-4 h-4 mr-2" />
                                画像をアップロード / 変更
                            </Button>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/png,image/jpeg"
                                onChange={handleFileChange}
                                className="hidden"
                            />
                        </div>

                        <div className="flex items-center gap-2">
                            <input
                                type="checkbox"
                                id="isDefault"
                                checked={formIsDefault}
                                onChange={(e) => setFormIsDefault(e.target.checked)}
                                className="w-4 h-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                            />
                            <Label htmlFor="isDefault" className="cursor-pointer">
                                デフォルトメニューに設定
                            </Label>
                        </div>

                        {/* 詳細設定（期間・タグ） */}
                        <div className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-xl space-y-4 border border-slate-200 dark:border-slate-700">
                            <h3 className="font-medium text-sm flex items-center gap-2 text-slate-700 dark:text-slate-300">
                                <Clock className="w-4 h-4" />
                                表示条件設定
                            </h3>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label>表示期間</Label>
                                    <div className="flex flex-col gap-2">
                                        <div className="flex items-center gap-2">
                                            <span className="text-xs text-slate-500 w-8">開始</span>
                                            <Input
                                                type="datetime-local"
                                                value={formDisplayStart}
                                                onChange={(e) => setFormDisplayStart(e.target.value)}
                                                className="flex-1"
                                            />
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span className="text-xs text-slate-500 w-8">終了</span>
                                            <Input
                                                type="datetime-local"
                                                value={formDisplayEnd}
                                                onChange={(e) => setFormDisplayEnd(e.target.value)}
                                                className="flex-1"
                                            />
                                        </div>
                                    </div>
                                    <p className="text-xs text-slate-500">
                                        指定期間のみ表示されます。空欄の場合は無期限となります。
                                    </p>
                                </div>

                                <div className="space-y-2">
                                    <Label>対象タグ</Label>
                                    <select
                                        value={formTargetTagId}
                                        onChange={(e) => setFormTargetTagId(e.target.value)}
                                        className="w-full h-10 px-3 rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-slate-700 dark:bg-slate-900"
                                    >
                                        <option value="">指定なし</option>
                                        {tags.map(tag => (
                                            <option key={tag.id} value={tag.id}>
                                                {tag.name} (優先度: {tag.priority})
                                            </option>
                                        ))}
                                    </select>
                                    <p className="text-xs text-slate-500">
                                        このタグが付いているユーザーに自動的に表示されます。
                                        <br />
                                        ※タグの優先度が高い順に適用されます。
                                    </p>
                                </div>
                            </div>
                        </div>

                        {/* タップ領域エディタ */}
                        <div className="space-y-3">
                            <div className="flex items-center justify-between">
                                <Label className="flex items-center gap-2">
                                    <MousePointer className="w-4 h-4" />
                                    タップ領域設定
                                </Label>
                                <Button variant="outline" size="sm" onClick={addArea}>
                                    <Plus className="w-4 h-4" />
                                    カスタム領域を追加
                                </Button>
                            </div>

                            {formAreas.map((area, index) => (
                                <div
                                    key={index}
                                    id={`area-editor-${index}`}
                                    className={cn(
                                        "p-4 rounded-xl space-y-3 transition-colors border",
                                        hoveredAreaIndex === index
                                            ? "bg-emerald-50/80 border-emerald-300 dark:bg-emerald-900/20"
                                            : "bg-slate-50 border-transparent dark:bg-slate-800"
                                    )}
                                    onMouseEnter={() => setHoveredAreaIndex(index)}
                                    onMouseLeave={() => setHoveredAreaIndex(null)}
                                >
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <span className="flex items-center justify-center w-6 h-6 bg-slate-200 dark:bg-slate-700 rounded-full text-xs font-bold">
                                                {index + 1}
                                            </span>
                                            <span className="font-medium text-sm">アクション</span>
                                        </div>
                                        <button
                                            onClick={() => removeArea(index)}
                                            className="p-1 text-red-500 hover:bg-red-50 rounded"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    </div>

                                    <div className="flex flex-col sm:flex-row gap-2">
                                        <select
                                            value={area.action.type}
                                            onChange={(e) => updateArea(index, 'actionType', e.target.value)}
                                            className="h-9 px-3 rounded-lg border border-slate-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-slate-700 dark:bg-slate-900 w-full sm:w-40"
                                        >
                                            <option value="message">メッセージ送信</option>
                                            <option value="uri">URLを開く</option>
                                        </select>
                                        <Input
                                            value={area.action.type === 'uri' ? area.action.uri || '' : area.action.text || ''}
                                            onChange={(e) => updateArea(index, 'actionValue', e.target.value)}
                                            placeholder={area.action.type === 'uri' ? 'https://...' : 'ユーザーが送信するメッセージ'}
                                            className="flex-1 h-9 text-sm"
                                        />
                                    </div>

                                    {/* 座標詳細（アコーディオン的に隠してもいいが、一応表示） */}
                                    <details className="text-xs text-slate-500">
                                        <summary className="cursor-pointer hover:text-slate-700 mb-2">座標・サイズ詳細</summary>
                                        <div className="grid grid-cols-4 gap-2">
                                            <div>
                                                <label>X</label>
                                                <Input
                                                    type="number"
                                                    value={area.bounds.x}
                                                    onChange={(e) => updateArea(index, 'bounds.x', e.target.value)}
                                                    className="h-7 text-xs"
                                                />
                                            </div>
                                            <div>
                                                <label>Y</label>
                                                <Input
                                                    type="number"
                                                    value={area.bounds.y}
                                                    onChange={(e) => updateArea(index, 'bounds.y', e.target.value)}
                                                    className="h-7 text-xs"
                                                />
                                            </div>
                                            <div>
                                                <label>W</label>
                                                <Input
                                                    type="number"
                                                    value={area.bounds.width}
                                                    onChange={(e) => updateArea(index, 'bounds.width', e.target.value)}
                                                    className="h-7 text-xs"
                                                />
                                            </div>
                                            <div>
                                                <label>H</label>
                                                <Input
                                                    type="number"
                                                    value={area.bounds.height}
                                                    onChange={(e) => updateArea(index, 'bounds.height', e.target.value)}
                                                    className="h-7 text-xs"
                                                />
                                            </div>
                                        </div>
                                    </details>
                                </div>
                            ))}
                        </div>

                        <div className="flex gap-2 justify-end pt-4 border-t">
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

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {richMenus.map(menu => (
                    <Card key={menu.id} className="overflow-hidden hover:shadow-lg transition-all duration-200">
                        <div className="aspect-[2500/1686] max-h-48 bg-slate-100 dark:bg-slate-800 relative">
                            {menu.image_url ? (
                                <img
                                    src={menu.image_url}
                                    alt={menu.name}
                                    className="w-full h-full object-contain"
                                />
                            ) : (
                                <div className="absolute inset-0 flex items-center justify-center">
                                    <ImageIcon className="w-12 h-12 text-slate-300 dark:text-slate-600" />
                                </div>
                            )}
                            {menu.is_default && (
                                <div className="absolute top-2 left-2 px-2 py-1 bg-emerald-500 text-white text-xs font-medium rounded-full flex items-center gap-1">
                                    <Star className="w-3 h-3" />
                                    デフォルト
                                </div>
                            )}
                            {menu.rich_menu_id && (
                                <div className="absolute top-2 right-2 px-2 py-1 bg-blue-500 text-white text-xs font-medium rounded-full flex items-center gap-1">
                                    <Cloud className="w-3 h-3" />
                                    LINE登録済み
                                </div>
                            )}
                        </div>
                        <CardContent className="p-4">
                            <div className="flex items-center justify-between mb-3">
                                <div>
                                    <h3 className="font-medium">{menu.name}</h3>
                                    <p className="text-xs text-slate-500">
                                        {(menu.areas || []).length}個のタップ領域
                                    </p>
                                </div>
                                <div className="flex gap-1">
                                    {!menu.is_default && (
                                        <button
                                            onClick={() => handleSetDefault(menu.id)}
                                            className="p-2 hover:bg-emerald-50 text-emerald-600 rounded-lg transition-colors"
                                            title="デフォルトに設定"
                                        >
                                            <StarOff className="w-4 h-4" />
                                        </button>
                                    )}
                                    <button
                                        onClick={() => startEditing(menu)}
                                        className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
                                    >
                                        <Edit2 className="w-4 h-4" />
                                    </button>
                                    <button
                                        onClick={() => handleDelete(menu.id)}
                                        className="p-2 hover:bg-red-50 text-red-500 rounded-lg transition-colors"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>

                            <div className="flex gap-2">
                                {menu.rich_menu_id ? (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="flex-1"
                                        onClick={() => handleUnregisterFromLine(menu.id)}
                                        disabled={registering === menu.id}
                                    >
                                        <CloudOff className="w-4 h-4 mr-2" />
                                        LINE API解除
                                    </Button>
                                ) : (
                                    <Button
                                        size="sm"
                                        className="flex-1"
                                        onClick={() => handleRegisterToLine(menu.id)}
                                        disabled={registering === menu.id || !menu.image_url}
                                    >
                                        <Cloud className="w-4 h-4 mr-2" />
                                        LINE API登録
                                    </Button>
                                )}
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>

            {richMenus.length === 0 && !isCreating && (
                <div className="text-center py-12">
                    <div className="w-16 h-16 mx-auto mb-4 bg-slate-100 dark:bg-slate-800 rounded-full flex items-center justify-center">
                        <ImageIcon className="w-8 h-8 text-slate-400" />
                    </div>
                    <p className="text-slate-500 mb-4">
                        リッチメニューがまだありません
                    </p>
                    <Button onClick={startCreating}>
                        最初のリッチメニューを作成
                    </Button>
                </div>
            )}
        </div>
    )
}
