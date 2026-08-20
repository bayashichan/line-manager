'use client'

import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button, Input, Label, Card, CardHeader, CardTitle, CardContent, Textarea } from '@/components/ui'
import { cn, getCookie } from '@/lib/utils'
import type { RichMenu, RichMenuArea } from '@/types'
import { isAreaConfigured } from '@/lib/rich-menu/areas'
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
    Calendar,
    Tag,
    Clock,
    AlertTriangle,
} from 'lucide-react'

import {
    MENU_WIDTH,
    MENU_HEIGHT_LARGE,
    MENU_HEIGHT_SMALL,
    MIN_AREA_SIZE,
    clamp,
    buildAreasFromLayout,
    rescaleAreas,
} from '@/lib/rich-menu/layout'

// UTC(ISO文字列)を datetime-local 用のローカル時刻文字列 (YYYY-MM-DDTHH:mm) に変換する。
// toISOString() をそのまま使うとUTCの壁時計時刻になり、保存時のローカル時刻解釈と
// ずれてしまう（例: JSTで23:59保存 → 再表示で14:59）ため、タイムゾーンオフセット分を補正する。
const toDatetimeLocalValue = (value: string | null | undefined): string => {
    if (!value) return ''
    const date = new Date(value)
    if (isNaN(date.getTime())) return ''
    const offsetMs = date.getTimezoneOffset() * 60000
    return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16)
}

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

    // メニューの高さ（大: 1686 / 小: 843）。画像のリサイズ先とタップ領域の座標系を兼ねる
    const [formMenuHeight, setFormMenuHeight] = useState<number>(MENU_HEIGHT_LARGE)
    // 段ごとの分割数（例: [3, 3] = 上段3個・下段3個）
    const [layoutRows, setLayoutRows] = useState<number[]>([3, 3])
    const [hoveredAreaIndex, setHoveredAreaIndex] = useState<number | null>(null) // ハイライト用

    // プレビュー上のドラッグ操作
    const [drag, setDrag] = useState<{
        mode: 'create' | 'move' | 'resize'
        index: number
        startX: number
        startY: number
        origin: RichMenuArea['bounds']
    } | null>(null)
    const [draftBounds, setDraftBounds] = useState<RichMenuArea['bounds'] | null>(null)

    const fileInputRef = useRef<HTMLInputElement>(null)
    const previewRef = useRef<HTMLDivElement>(null)
    // メニューサイズ変更時に再リサイズするため、アップロード前の元画像を保持する
    const originalImageFileRef = useRef<File | null>(null)
    // プレビュー中の画像の実サイズ（幅2500に換算した高さ）
    const [previewImageHeight, setPreviewImageHeight] = useState<number | null>(null)

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
        setFormMenuHeight(MENU_HEIGHT_LARGE)
        setLayoutRows([3, 3])
        setPreviewImageHeight(null)
        originalImageFileRef.current = null
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
        const savedAreas = menu.areas || []
        setFormAreas(savedAreas)
        // 保存済みの座標からメニューの高さを推定（画像読み込み後に実サイズで上書きされる）
        const maxBottom = savedAreas.reduce((max, a) => Math.max(max, a.bounds.y + a.bounds.height), 0)
        setFormMenuHeight(maxBottom > 0 && maxBottom <= MENU_HEIGHT_SMALL ? MENU_HEIGHT_SMALL : MENU_HEIGHT_LARGE)
        setPreviewImageHeight(null)
        originalImageFileRef.current = null
        // Period
        // DBにはUTCで保存されているため、datetime-localが期待するローカル時刻の
        // 壁時計表現に変換する（toISOStringだとUTCのまま表示され、時差分ずれる）
        setFormDisplayStart(toDatetimeLocalValue(menu.display_period_start))
        setFormDisplayEnd(toDatetimeLocalValue(menu.display_period_end))
        // Find linked tag
        const linkedTag = tags.find(t => t.linked_rich_menu_id === menu.id)
        setFormTargetTagId(linkedTag ? linkedTag.id : '')

        setIsCreating(false)
    }

    /** 段構成からタップ領域を作り直す */
    const applyLayout = () => {
        const hasInput = formAreas.some(area => isAreaConfigured(area))
        if (hasInput && !confirm('現在のタップ領域と入力済みのアクションは置き換えられます。よろしいですか？')) {
            return
        }
        setFormAreas(buildAreasFromLayout(layoutRows, formMenuHeight))
    }

    /** 段数を変更する（増えた段はデフォルト3分割） */
    const changeRowCount = (count: number) => {
        setLayoutRows(prev => Array.from({ length: count }, (_, i) => prev[i] ?? 3))
    }

    /** 特定の段の分割数を変更する */
    const changeRowColumns = (rowIndex: number, cols: number) => {
        setLayoutRows(prev => prev.map((c, i) => (i === rowIndex ? cols : c)))
    }

    /** メニューの高さ（大/小）を切り替える。タップ領域と画像を追従させる */
    const changeMenuHeight = async (height: number) => {
        if (height === formMenuHeight) return

        setFormAreas(prev => rescaleAreas(prev, formMenuHeight, height))
        setFormMenuHeight(height)

        // アップロード済みの画像があれば新しいサイズに作り直す
        // （画像とタップ領域の縦横比がずれると位置が合わなくなるため）
        const original = originalImageFileRef.current
        if (!original) return

        try {
            const resized = await resizeImage(original, MENU_WIDTH, height)
            setFormImageFile(resized)
            const reader = new FileReader()
            reader.onloadend = () => setFormImagePreview(reader.result as string)
            reader.readAsDataURL(resized)
        } catch (err) {
            console.error('Resize error:', err)
        }
    }

    /** プレビュー上の座標をメニューの座標系（2500 x formMenuHeight）に変換する */
    const toMenuPoint = (clientX: number, clientY: number) => {
        const rect = previewRef.current?.getBoundingClientRect()
        if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 }
        return {
            x: clamp(Math.round(((clientX - rect.left) / rect.width) * MENU_WIDTH), 0, MENU_WIDTH),
            y: clamp(Math.round(((clientY - rect.top) / rect.height) * formMenuHeight), 0, formMenuHeight),
        }
    }

    const startDrag = (
        e: React.PointerEvent,
        mode: 'create' | 'move' | 'resize',
        index: number
    ) => {
        e.preventDefault()
        e.stopPropagation()
        const point = toMenuPoint(e.clientX, e.clientY)
        const origin = formAreas[index]?.bounds ?? { x: point.x, y: point.y, width: 0, height: 0 }
        setDrag({ mode, index, startX: point.x, startY: point.y, origin })
        if (mode === 'create') setDraftBounds({ x: point.x, y: point.y, width: 0, height: 0 })
        e.currentTarget.setPointerCapture?.(e.pointerId)
    }

    const handleDragMove = (e: React.PointerEvent) => {
        if (!drag) return
        const point = toMenuPoint(e.clientX, e.clientY)

        if (drag.mode === 'create') {
            setDraftBounds({
                x: Math.min(drag.startX, point.x),
                y: Math.min(drag.startY, point.y),
                width: Math.abs(point.x - drag.startX),
                height: Math.abs(point.y - drag.startY),
            })
            return
        }

        const dx = point.x - drag.startX
        const dy = point.y - drag.startY

        setFormAreas(prev => prev.map((area, i) => {
            if (i !== drag.index) return area

            if (drag.mode === 'move') {
                return {
                    ...area,
                    bounds: {
                        ...drag.origin,
                        // メニューの外へはみ出さないよう移動量を制限する
                        // （領域がメニューより大きい場合に負値にならないよう max(0, ...) を挟む）
                        x: clamp(drag.origin.x + dx, 0, Math.max(0, MENU_WIDTH - drag.origin.width)),
                        y: clamp(drag.origin.y + dy, 0, Math.max(0, formMenuHeight - drag.origin.height)),
                    },
                }
            }

            // 右下ハンドルでのリサイズ。メニュー内に残る範囲でのみ広げられる
            const maxWidth = Math.max(1, MENU_WIDTH - drag.origin.x)
            const maxHeight = Math.max(1, formMenuHeight - drag.origin.y)

            return {
                ...area,
                bounds: {
                    ...drag.origin,
                    width: clamp(drag.origin.width + dx, Math.min(MIN_AREA_SIZE, maxWidth), maxWidth),
                    height: clamp(drag.origin.height + dy, Math.min(MIN_AREA_SIZE, maxHeight), maxHeight),
                },
            }
        }))
    }

    const endDrag = () => {
        if (drag?.mode === 'create' && draftBounds) {
            // 小さすぎるドラッグは誤操作とみなして無視する
            if (draftBounds.width >= MIN_AREA_SIZE && draftBounds.height >= MIN_AREA_SIZE) {
                setFormAreas(prev => [
                    ...prev,
                    { bounds: draftBounds, action: { type: 'message', text: '' } },
                ])
            }
        }
        setDrag(null)
        setDraftBounds(null)
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
        // LINEは空のアクションを受け付けないため、登録前に未設定エリアを確認する
        const target = richMenus.find(m => m.id === menuId)
        const areas = target?.areas || []
        const unsetAreaNumbers = areas
            .map((area, index) => (isAreaConfigured(area) ? null : index + 1))
            .filter((n): n is number => n !== null)

        if (areas.length > 0 && unsetAreaNumbers.length === areas.length) {
            alert('タップ領域のアクションが未入力です。\n編集画面で各エリアにメッセージ本文またはURLを入力し、保存してから登録してください。')
            return
        }

        if (unsetAreaNumbers.length > 0) {
            const ok = confirm(
                `エリア ${unsetAreaNumbers.join(', ')} のアクションが未入力です。\n` +
                'これらの領域はタップしても何も起こらない状態で登録されます。続行しますか？'
            )
            if (!ok) return
        }

        setRegistering(menuId)
        try {
            const response = await fetch('/api/rich-menus/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ richMenuId: menuId }),
            })

            const data = await response.json()

            if (!response.ok) {
                const errorMsg = data.error || 'LINE APIへの登録に失敗しました'
                const debugInfo = data.details ? `\n詳細: ${JSON.stringify(data.details, null, 2)}` : ''
                throw new Error(`${errorMsg}${debugInfo}`)
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
            originalImageFileRef.current = file

            try {
                // 選択中のメニューサイズに合わせて自動リサイズ
                // （画像とタップ領域の座標系がずれると登録時にはみ出しエラーになるため）
                const resizedFile = await resizeImage(file, MENU_WIDTH, formMenuHeight)
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
            {
                bounds: {
                    x: 0,
                    y: 0,
                    width: Math.round(MENU_WIDTH / 3),
                    height: Math.round(formMenuHeight / 2),
                },
                action: { type: 'message', text: '' },
            },
        ])
    }

    const updateArea = (index: number, field: string, value: any) => {
        const updated = [...formAreas]
        if (field === 'actionType') {
            // 種別に不要なプロパティ（messageなのにuri等）を残さない
            updated[index] = {
                ...updated[index],
                action: value === 'uri' ? { type: 'uri', uri: '' } : { type: 'message', text: '' },
            }
        } else if (field === 'actionValue') {
            const actionField = updated[index].action.type === 'uri' ? 'uri' : 'text'
            updated[index] = { ...updated[index], action: { ...updated[index].action, [actionField]: value } }
        } else {
            const [parent, child] = field.split('.')
            if (parent === 'bounds') {
                // メニューの外へはみ出す値は入力できないようにする
                const max = child === 'x' || child === 'width' ? MENU_WIDTH : formMenuHeight
                const next = clamp(parseInt(value) || 0, 0, max)
                updated[index] = { ...updated[index], bounds: { ...updated[index].bounds, [child]: next } }
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

                        {/* レイアウト（段ごとの分割数）からタップ領域を作成 */}
                        <div className="space-y-3">
                            <Label className="flex items-center gap-2">
                                <LayoutTemplate className="w-4 h-4" />
                                レイアウトから作成
                            </Label>

                            <div className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-xl space-y-4 border border-slate-200 dark:border-slate-700">
                                <div className="space-y-2">
                                    <span className="text-xs font-medium text-slate-600 dark:text-slate-400">メニューの大きさ</span>
                                    <div className="flex gap-2">
                                        {[
                                            { height: MENU_HEIGHT_LARGE, label: '大', hint: '2500 x 1686' },
                                            { height: MENU_HEIGHT_SMALL, label: '小', hint: '2500 x 843' },
                                        ].map(option => (
                                            <button
                                                key={option.height}
                                                onClick={() => changeMenuHeight(option.height)}
                                                className={cn(
                                                    "flex-1 px-3 py-2 rounded-lg border-2 text-sm transition-all",
                                                    formMenuHeight === option.height
                                                        ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20"
                                                        : "border-slate-200 hover:border-slate-300 bg-white dark:bg-slate-900 dark:border-slate-700"
                                                )}
                                            >
                                                <span className="font-medium">{option.label}</span>
                                                <span className="ml-2 text-[11px] text-slate-400">{option.hint}</span>
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <span className="text-xs font-medium text-slate-600 dark:text-slate-400">段数</span>
                                    <div className="flex gap-2">
                                        {[1, 2, 3].map(count => (
                                            <button
                                                key={count}
                                                onClick={() => changeRowCount(count)}
                                                className={cn(
                                                    "flex-1 px-3 py-2 rounded-lg border-2 text-sm transition-all",
                                                    layoutRows.length === count
                                                        ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20"
                                                        : "border-slate-200 hover:border-slate-300 bg-white dark:bg-slate-900 dark:border-slate-700"
                                                )}
                                            >
                                                {count}段
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    {layoutRows.map((cols, rowIndex) => (
                                        <div key={rowIndex} className="flex items-center gap-3">
                                            <span className="text-xs text-slate-600 dark:text-slate-400 w-16 shrink-0">
                                                {layoutRows.length === 1
                                                    ? '全体'
                                                    : rowIndex === 0
                                                        ? '上段'
                                                        : rowIndex === layoutRows.length - 1
                                                            ? '下段'
                                                            : '中段'}
                                            </span>
                                            <div className="flex gap-1 flex-wrap">
                                                {[1, 2, 3, 4, 5].map(n => (
                                                    <button
                                                        key={n}
                                                        onClick={() => changeRowColumns(rowIndex, n)}
                                                        className={cn(
                                                            "w-10 h-9 rounded-lg border-2 text-sm transition-all",
                                                            cols === n
                                                                ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20"
                                                                : "border-slate-200 hover:border-slate-300 bg-white dark:bg-slate-900 dark:border-slate-700"
                                                        )}
                                                    >
                                                        {n}
                                                    </button>
                                                ))}
                                                <span className="self-center text-xs text-slate-400 ml-1">個</span>
                                            </div>
                                        </div>
                                    ))}
                                </div>

                                <Button variant="outline" className="w-full" onClick={applyLayout}>
                                    <Grid className="w-4 h-4 mr-2" />
                                    この構成でタップ領域を作成
                                </Button>
                                <p className="text-xs text-slate-500">
                                    押すと現在のタップ領域は置き換えられます。作成後はプレビュー上でドラッグして自由に調整できます。
                                </p>
                            </div>
                        </div>

                        <div className="space-y-2">
                            <Label>メニュー画像</Label>


                            {/* ビジュアルエディタ（ドラッグでタップ領域を作成・移動・リサイズ） */}
                            <div className="relative w-full max-w-2xl mx-auto border rounded-xl overflow-hidden bg-slate-100 dark:bg-slate-800">
                                <div
                                    ref={previewRef}
                                    className="relative w-full touch-none select-none cursor-crosshair"
                                    style={{ aspectRatio: `${MENU_WIDTH} / ${formMenuHeight}` }}
                                    onPointerDown={(e) => startDrag(e, 'create', -1)}
                                    onPointerMove={handleDragMove}
                                    onPointerUp={endDrag}
                                    onPointerCancel={endDrag}
                                >
                                    {formImagePreview ? (
                                        <img
                                            src={formImagePreview}
                                            alt="プレビュー"
                                            className="absolute inset-0 w-full h-full object-contain pointer-events-none"
                                            onLoad={(e) => {
                                                // 保存済み画像の実サイズからメニューの大きさを判定する
                                                // （座標系と画像がずれると登録時にはみ出しエラーになる）
                                                const img = e.currentTarget
                                                if (!img.naturalWidth || !img.naturalHeight) return
                                                const scaledHeight = Math.round((img.naturalHeight / img.naturalWidth) * MENU_WIDTH)
                                                setPreviewImageHeight(scaledHeight)
                                                const detected = scaledHeight < (MENU_HEIGHT_SMALL + MENU_HEIGHT_LARGE) / 2
                                                    ? MENU_HEIGHT_SMALL
                                                    : MENU_HEIGHT_LARGE
                                                if (detected !== formMenuHeight) changeMenuHeight(detected)
                                            }}
                                        />
                                    ) : (
                                        <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 pointer-events-none">
                                            <ImageIcon className="w-12 h-12 mb-2" />
                                            <p className="text-sm">画像未設定</p>
                                            <p className="text-xs opacity-70">
                                                推奨: {MENU_WIDTH} x {formMenuHeight}
                                            </p>
                                        </div>
                                    )}

                                    {formAreas.map((area, index) => (
                                        <div
                                            key={index}
                                            className={cn(
                                                "absolute border-2 flex items-center justify-center text-xs font-bold text-white shadow-sm cursor-move",
                                                hoveredAreaIndex === index
                                                    ? "bg-emerald-500/50 border-emerald-400 z-10"
                                                    : "bg-black/30 border-white/50 hover:bg-black/40"
                                            )}
                                            style={{
                                                left: `${(area.bounds.x / MENU_WIDTH) * 100}%`,
                                                top: `${(area.bounds.y / formMenuHeight) * 100}%`,
                                                width: `${(area.bounds.width / MENU_WIDTH) * 100}%`,
                                                height: `${(area.bounds.height / formMenuHeight) * 100}%`,
                                            }}
                                            onMouseEnter={() => setHoveredAreaIndex(index)}
                                            onMouseLeave={() => setHoveredAreaIndex(null)}
                                            onPointerDown={(e) => startDrag(e, 'move', index)}
                                            onPointerMove={handleDragMove}
                                            onPointerUp={endDrag}
                                            onPointerCancel={endDrag}
                                            onDoubleClick={() => {
                                                document.getElementById(`area-editor-${index}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                                            }}
                                        >
                                            <span className="bg-black/50 px-2 py-1 rounded-full backdrop-blur-sm pointer-events-none">
                                                {index + 1}
                                            </span>

                                            {/* 右下のリサイズハンドル */}
                                            <span
                                                className="absolute right-0 bottom-0 w-4 h-4 rounded-sm bg-white border-2 border-emerald-500 cursor-nwse-resize"
                                                onPointerDown={(e) => startDrag(e, 'resize', index)}
                                                onPointerMove={handleDragMove}
                                                onPointerUp={endDrag}
                                                onPointerCancel={endDrag}
                                            />
                                        </div>
                                    ))}

                                    {/* ドラッグ中の新規領域 */}
                                    {draftBounds && (
                                        <div
                                            className="absolute border-2 border-dashed border-emerald-400 bg-emerald-500/30 pointer-events-none"
                                            style={{
                                                left: `${(draftBounds.x / MENU_WIDTH) * 100}%`,
                                                top: `${(draftBounds.y / formMenuHeight) * 100}%`,
                                                width: `${(draftBounds.width / MENU_WIDTH) * 100}%`,
                                                height: `${(draftBounds.height / formMenuHeight) * 100}%`,
                                            }}
                                        />
                                    )}
                                </div>
                            </div>

                            {previewImageHeight !== null &&
                                Math.abs(previewImageHeight - formMenuHeight) > 50 &&
                                !originalImageFileRef.current && (
                                    <p className="mt-2 flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
                                        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                                        設定中のメニューサイズ（{MENU_WIDTH} x {formMenuHeight}）と画像の比率が異なります。
                                        画像を選び直すか、メニューの大きさを戻してください。
                                    </p>
                                )}

                            <p className="text-xs text-slate-500 mt-2 text-center">
                                画像の上をドラッグすると新しいタップ領域を作成できます。枠内をドラッグで移動、右下の白い四角をドラッグでサイズ変更、ダブルクリックでアクション入力欄へ移動します。
                            </p>


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
                                            {!isAreaConfigured(area) && (
                                                <span className="flex items-center gap-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                                                    <AlertTriangle className="w-3 h-3" />
                                                    未設定
                                                </span>
                                            )}
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
                                        {area.action.type === 'message' ? (
                                            <Textarea
                                                value={area.action.text || ''}
                                                onChange={(e) => updateArea(index, 'actionValue', e.target.value)}
                                                placeholder="ユーザーが送信するメッセージ（改行も可能です）"
                                                className="flex-1 min-h-[36px] text-sm resize-y"
                                                rows={2}
                                            />
                                        ) : (
                                            <Input
                                                value={area.action.uri || ''}
                                                onChange={(e) => updateArea(index, 'actionValue', e.target.value)}
                                                placeholder="https://..."
                                                className="flex-1 h-9 text-sm"
                                            />
                                        )}
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
