'use client'

import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button, Input, Label, Card, CardHeader, CardTitle, CardContent, Textarea, useToast } from '@/components/ui'
import { RichMenuRulesPanel, formatMenuDate } from '@/components/rich-menu-rules-panel'
import { cn, getCookie } from '@/lib/utils'
import type { RichMenu, RichMenuArea, Tag } from '@/types'
import { isAreaConfigured } from '@/lib/rich-menu/areas'
import { pickAllUsersMenu } from '@/lib/rich-menu/plan'
import type { RichMenuSyncResult } from '@/lib/rich-menu/sync'
import { uploadToR2 } from '@/lib/storage/upload-client'
import {
    Plus,
    Edit2,
    Trash2,
    Save,
    Upload,
    Star,
    Loader2,
    Image as ImageIcon,
    X,
    Cloud,
    MousePointer,
    LayoutTemplate,
    Grid,
    Tag as TagIcon,
    Clock,
    AlertTriangle,
    Users,
    CalendarClock,
} from 'lucide-react'

/** 反映結果を一言にまとめる */
const summarizeSyncResult = (result: RichMenuSyncResult): string => {
    const parts: string[] = []
    if (result.allUsersMenu) {
        parts.push(`全員向け:「${result.allUsersMenu.name}」`)
    }
    if (result.linked > 0) parts.push(`タグ別メニュー: ${result.linked}人`)
    if (result.unlinked > 0) parts.push(`全員向けに合わせた人: ${result.unlinked}人`)
    if (result.published.length > 0) {
        parts.push(`LINEに反映したメニュー: ${result.published.map(m => `「${m.name}」`).join('')}`)
    }
    return parts.length > 0 ? parts.join(' / ') : '変更はありませんでした'
}

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
    const [tags, setTags] = useState<Tag[]>([])
    const [loading, setLoading] = useState(true)
    const [currentChannelId, setCurrentChannelId] = useState<string | null>(null)
    const [isCreating, setIsCreating] = useState(false)
    const [editingMenu, setEditingMenu] = useState<RichMenu | null>(null)
    const [saving, setSaving] = useState(false)
    // LINEへの反映中（表示ルールの変更・保存後の反映）
    const [applying, setApplying] = useState(false)
    const { toast } = useToast()

    // フォーム
    const [formName, setFormName] = useState('')
    const [formImageFile, setFormImageFile] = useState<File | null>(null)
    const [formImagePreview, setFormImagePreview] = useState<string | null>(null)
    const [formIsDefault, setFormIsDefault] = useState(false)
    const [formAreas, setFormAreas] = useState<RichMenuArea[]>([])
    // New fields
    const [formDisplayStart, setFormDisplayStart] = useState<string>('')
    const [formDisplayEnd, setFormDisplayEnd] = useState<string>('')
    // このメニューを表示するタグ（複数可）
    const [formTagIds, setFormTagIds] = useState<string[]>([])

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
        setFormTagIds([])
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
        // このメニューを表示しているタグ
        setFormTagIds(tags.filter(t => t.linked_rich_menu_id === menu.id).map(t => t.id))

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



    /**
     * 表示ルールを保存して LINE に反映する（サーバー側で登録・付け替え・古い版の削除まで行う）
     */
    const applyRules = async (
        payload: {
            defaultMenuId?: string | null
            tagMenus?: { tagId: string; menuId: string | null }[]
            menuTags?: { menuId: string; tagIds: string[] }
            editedMenuIds?: string[]
            force?: boolean
        },
        successTitle: string
    ): Promise<boolean> => {
        if (!currentChannelId) return false

        setApplying(true)
        try {
            const response = await fetch('/api/rich-menus/apply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channelId: currentChannelId, ...payload }),
            })
            const data = await response.json().catch(() => ({}))

            if (!response.ok) {
                throw new Error(data.error || 'LINEへの反映に失敗しました')
            }

            const result = data as RichMenuSyncResult
            const skipped = result.published
                .filter(m => m.skippedAreaNumbers.length > 0)
                .map(m => `「${m.name}」のエリア ${m.skippedAreaNumbers.join(', ')} はアクション未入力のため、タップしても何も起きません。`)

            toast({
                title: successTitle,
                description: [summarizeSyncResult(result), ...skipped].join('\n'),
            })

            if (result.warnings.length > 0) {
                toast({
                    title: '一部をLINEに反映できませんでした',
                    description: result.warnings.join('\n'),
                    variant: 'destructive',
                })
            }
            return true
        } catch (error) {
            console.error('リッチメニュー反映エラー:', error)
            toast({
                title: 'LINEへの反映に失敗しました',
                description: error instanceof Error ? error.message : String(error),
                variant: 'destructive',
            })
            return false
        } finally {
            await fetchData(currentChannelId)
            setApplying(false)
        }
    }

    const handleSave = async () => {
        if (!formName.trim() || !currentChannelId) return

        if (editingMenu?.is_default && !formIsDefault && !confirm(
            '「全員に使う」を外すと、タグ別の設定がない人に表示するメニューがなくなります（LINE公式アカウントマネージャーの設定に従います）。\n' +
            '別のメニューを全員に使う場合は、そのメニューの「全員にこれを使う」を押すと自動で切り替わります。このまま保存しますか？'
        )) {
            return
        }

        setSaving(true)
        const supabase = createClient()

        try {
            let imageUrl = editingMenu?.image_url || null

            if (formImageFile) {
                // リッチメニュー画像はLINEの仕様でサイズが固定なので圧縮・リサイズはしない。
                // 拡張子とContent-Typeは実際の中身（JPEG）に合わせる。
                // ずれるとLINEへ誤ったContent-Typeで転送され、Androidで描画できなくなる
                const contentType = formImageFile.type || 'image/jpeg'
                const fileExt = contentType === 'image/png' ? 'png' : 'jpg'
                const named = new File([formImageFile], `${Date.now()}.${fileExt}`, { type: contentType })

                try {
                    imageUrl = await uploadToR2(named, currentChannelId, { prefix: 'rich-menus' })
                } catch (err) {
                    console.error('リッチメニュー画像のアップロードに失敗:', err)
                    alert(err instanceof Error ? err.message : '画像のアップロードに失敗しました')
                    return
                }
            }

            let savedMenuId: string | null = null

            const periodStart = formDisplayStart ? new Date(formDisplayStart).toISOString() : null
            const periodEnd = formDisplayEnd ? new Date(formDisplayEnd).toISOString() : null

            // 中身（名前・画像・タップ領域・表示期間）だけを保存する。
            // 「全員に使う」「タグ」の設定は LINE への反映と一緒にサーバー側で保存する
            const content = {
                name: formName,
                image_url: imageUrl,
                areas: formAreas,
                display_period_start: periodStart,
                display_period_end: periodEnd,
            }

            if (editingMenu) {
                const { error } = await supabase
                    .from('rich_menus')
                    .update(content)
                    .eq('id', editingMenu.id)
                if (error) throw error
                savedMenuId = editingMenu.id
            } else {
                const { data: inserted, error } = await supabase
                    .from('rich_menus')
                    .insert({ channel_id: currentChannelId, is_default: false, ...content })
                    .select()
                    .single()
                if (error) throw error
                savedMenuId = inserted.id
            }

            if (!savedMenuId) throw new Error('保存に失敗しました')

            const wasDefault = editingMenu?.is_default ?? false
            const defaultChanged = formIsDefault !== wasDefault
            const originalTagIds = editingMenu
                ? tags.filter(t => t.linked_rich_menu_id === editingMenu.id).map(t => t.id)
                : []
            const tagsChanged =
                formTagIds.length !== originalTagIds.length ||
                formTagIds.some(id => !originalTagIds.includes(id))

            resetForm()

            // 使用中のメニューなら、編集した内容で LINE 上のメニューを作り直して付け替える
            await applyRules(
                {
                    editedMenuIds: [savedMenuId],
                    ...(defaultChanged ? { defaultMenuId: formIsDefault ? savedMenuId : null } : {}),
                    ...(tagsChanged ? { menuTags: { menuId: savedMenuId, tagIds: formTagIds } } : {}),
                    // 表示する相手を変えたときは、全員の表示を LINE に送り直して確実に揃える
                    force: defaultChanged || tagsChanged,
                },
                '保存してLINEに反映しました'
            )
        } catch (error) {
            console.error('保存エラー:', error)
            toast({
                title: '保存に失敗しました',
                description: error instanceof Error ? error.message : String(error),
                variant: 'destructive',
            })
        } finally {
            setSaving(false)
        }
    }

    const handleDelete = async (menu: RichMenu) => {
        const usage: string[] = []
        if (menu.is_default) usage.push('全員向け')
        const linkedTagNames = tags.filter(t => t.linked_rich_menu_id === menu.id).map(t => t.name)
        if (linkedTagNames.length > 0) usage.push(`タグ「${linkedTagNames.join('」「')}」`)

        const message = usage.length > 0
            ? `「${menu.name}」は${usage.join('・')}に表示中です。\n削除すると、その人たちには${menu.is_default ? '（全員向けがなくなるため）LINE公式アカウントマネージャーで設定したメニュー' : '全員向けのメニュー'}が表示されます。削除しますか？`
            : `「${menu.name}」を削除しますか？`
        if (!confirm(message)) return

        setApplying(true)
        try {
            const response = await fetch(`/api/rich-menus?id=${menu.id}`, { method: 'DELETE' })
            const data = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(data.error || '削除に失敗しました')

            toast({ title: `「${menu.name}」を削除しました` })
            if (data.warnings?.length > 0) {
                toast({ title: '一部をLINEに反映できませんでした', description: data.warnings.join('\n'), variant: 'destructive' })
            }
        } catch (error) {
            toast({
                title: '削除に失敗しました',
                description: error instanceof Error ? error.message : String(error),
                variant: 'destructive',
            })
        } finally {
            if (currentChannelId) await fetchData(currentChannelId)
            setApplying(false)
        }
    }

    /** ワンタッチで「全員にこのメニューを使う」 */
    const handleSetDefault = (menuId: string | null) => {
        const name = menuId ? richMenus.find(m => m.id === menuId)?.name : null
        applyRules(
            { defaultMenuId: menuId },
            name ? `「${name}」を全員に表示しました` : '全員向けのメニューを外しました'
        )
    }

    /** ワンタッチで「このタグの人にはこのメニューを使う」 */
    const handleSetTagMenu = (tagId: string, menuId: string | null) => {
        const tagName = tags.find(t => t.id === tagId)?.name ?? ''
        const menuName = menuId ? richMenus.find(m => m.id === menuId)?.name : null
        applyRules(
            { tagMenus: [{ tagId, menuId }] },
            menuName
                ? `タグ「${tagName}」の人に「${menuName}」を表示しました`
                : `タグ「${tagName}」のメニュー設定を外しました`
        )
    }

    /** 全員の表示を設定どおりに LINE へ送り直す */
    const handleResync = () => {
        applyRules({ force: true }, 'LINEと揃え直しました')
    }

    // LINEのリッチメニュー画像は1MBまで。超えるとアップロード時に413で弾かれる
    const MAX_IMAGE_BYTES = 1024 * 1024

    /** canvasをJPEGで書き出す。1MBに収まるまで品質を落とす */
    const canvasToJpegBlob = async (canvas: HTMLCanvasElement): Promise<Blob> => {
        const toBlob = (quality: number) =>
            new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))

        let last: Blob | null = null
        for (const quality of [0.9, 0.8, 0.7, 0.6, 0.5]) {
            const blob = await toBlob(quality)
            if (!blob) continue
            last = blob
            if (blob.size <= MAX_IMAGE_BYTES) return blob
        }

        if (!last) throw new Error('Canvas blob failure')
        return last
    }

    // 画像を指定サイズにリサイズする関数
    const resizeImage = (file: File, width: number, height: number): Promise<File> => {
        return new Promise((resolve, reject) => {
            const img = new Image()
            const reader = new FileReader()

            reader.onload = (e) => {
                img.src = e.target?.result as string
            }

            img.onload = async () => {
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

                // 余白が出ると座標系と画像がずれるため、歪んでも枠いっぱいに描画する
                ctx.drawImage(img, 0, 0, width, height)

                try {
                    const blob = await canvasToJpegBlob(canvas)

                    // 中身はJPEGなので拡張子もJPEGに揃える。
                    // 拡張子と中身が食い違うとストレージに誤ったContent-Typeで保存され、
                    // Androidのリッチメニューが「読み込み中」のまま表示されなくなる
                    const baseName = file.name.replace(/\.[^.]+$/, '') || 'rich-menu'
                    resolve(new File([blob], `${baseName}.jpg`, {
                        type: 'image/jpeg',
                        lastModified: Date.now(),
                    }))
                } catch (err) {
                    reject(err)
                }
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

    // いま全員向けに表示しているメニュー（表示期間中のメニュー ＞ 基本のメニュー）
    const allUsersMenu = pickAllUsersMenu(richMenus, new Date())

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

            {!isCreating && !editingMenu && richMenus.length > 0 && (
                <RichMenuRulesPanel
                    menus={richMenus}
                    tags={tags}
                    applying={applying}
                    onSetDefault={handleSetDefault}
                    onSetTagMenu={handleSetTagMenu}
                    onResync={handleResync}
                />
            )}

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

                        {/* このメニューを見せる相手 */}
                        <div className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-xl space-y-4 border border-slate-200 dark:border-slate-700">
                            <h3 className="font-medium text-sm flex items-center gap-2 text-slate-700 dark:text-slate-300">
                                <Users className="w-4 h-4" />
                                このメニューを見せる相手
                            </h3>

                            <label className="flex items-start gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={formIsDefault}
                                    onChange={(e) => setFormIsDefault(e.target.checked)}
                                    className="mt-0.5 w-4 h-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                                />
                                <span className="text-sm">
                                    全員に使う（基本のメニュー）
                                    <span className="block text-xs text-slate-500">
                                        タグ別の設定がない人全員に表示します。基本のメニューは1つだけで、ほかのメニューからは外れます。
                                    </span>
                                </span>
                            </label>

                            <div className="space-y-2">
                                <span className="text-sm">このタグが付いている人に使う</span>
                                {tags.length === 0 ? (
                                    <p className="text-xs text-slate-500">タグがまだありません（タグ管理で作成できます）。</p>
                                ) : (
                                    <div className="flex flex-wrap gap-2">
                                        {tags.map(tag => {
                                            const selected = formTagIds.includes(tag.id)
                                            const otherMenu = tag.linked_rich_menu_id && tag.linked_rich_menu_id !== editingMenu?.id
                                                ? richMenus.find(m => m.id === tag.linked_rich_menu_id)
                                                : null
                                            return (
                                                <button
                                                    key={tag.id}
                                                    type="button"
                                                    onClick={() => setFormTagIds(prev =>
                                                        selected ? prev.filter(id => id !== tag.id) : [...prev, tag.id]
                                                    )}
                                                    className={cn(
                                                        "flex items-center gap-1.5 px-3 py-1.5 rounded-full border-2 text-sm transition-all",
                                                        selected
                                                            ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20"
                                                            : "border-slate-200 bg-white hover:border-slate-300 dark:bg-slate-900 dark:border-slate-700"
                                                    )}
                                                    title={otherMenu ? `今は「${otherMenu.name}」を表示中。選ぶとこのメニューに切り替わります` : undefined}
                                                >
                                                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: tag.color }} />
                                                    {tag.name}
                                                    {otherMenu && !selected && (
                                                        <span className="text-[11px] text-slate-400">（今:{otherMenu.name}）</span>
                                                    )}
                                                </button>
                                            )
                                        })}
                                    </div>
                                )}
                                <p className="text-xs text-slate-500">
                                    タグ別のメニューは全員向けより優先されます。複数のタグが付いている人には、優先度が高いタグのメニューが表示されます。
                                </p>
                            </div>

                            <div className="space-y-2">
                                <Label className="flex items-center gap-2">
                                    <Clock className="w-4 h-4" />
                                    表示期間（任意）
                                </Label>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
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
                                    開始と終了を両方入れると、その期間だけ全員向けにこのメニューを表示し、終わると基本のメニューに自動で戻ります（タグ別の人はタグのメニューのまま）。
                                </p>
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
                            <Button onClick={handleSave} disabled={saving || applying || !formName.trim()}>
                                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                                保存してLINEに反映
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {richMenus.map(menu => {
                    const linkedTags = tags.filter(t => t.linked_rich_menu_id === menu.id)
                    const isShowingToAll = allUsersMenu?.id === menu.id
                    const hasPeriod = Boolean(menu.display_period_start && menu.display_period_end)
                    const inUse = isShowingToAll || menu.is_default || linkedTags.length > 0 || hasPeriod
                    const assignableTags = tags.filter(t => t.linked_rich_menu_id !== menu.id)

                    return (
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
                                {menu.rich_menu_id && (
                                    <div
                                        className="absolute top-2 right-2 px-2 py-1 bg-blue-500/90 text-white text-[11px] font-medium rounded-full flex items-center gap-1"
                                        title="LINEに反映済みです。編集して保存すると自動で作り直されます"
                                    >
                                        <Cloud className="w-3 h-3" />
                                        LINE反映済み
                                    </div>
                                )}
                            </div>
                            <CardContent className="p-4 space-y-3">
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                        <h3 className="font-medium truncate">{menu.name}</h3>
                                        <p className="text-xs text-slate-500">
                                            {(menu.areas || []).length}個のタップ領域
                                        </p>
                                    </div>
                                    <div className="flex gap-1 shrink-0">
                                        <button
                                            onClick={() => startEditing(menu)}
                                            className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
                                            title="編集"
                                        >
                                            <Edit2 className="w-4 h-4" />
                                        </button>
                                        <button
                                            onClick={() => handleDelete(menu)}
                                            disabled={applying}
                                            className="p-2 hover:bg-red-50 text-red-500 rounded-lg transition-colors disabled:opacity-50"
                                            title="削除"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    </div>
                                </div>

                                {/* 今だれに表示しているか */}
                                <div className="flex flex-wrap gap-1.5">
                                    {isShowingToAll && (
                                        <span className="px-2 py-0.5 bg-emerald-500 text-white text-xs font-medium rounded-full flex items-center gap-1">
                                            <Users className="w-3 h-3" />
                                            全員に表示中
                                        </span>
                                    )}
                                    {menu.is_default && !isShowingToAll && (
                                        <span className="px-2 py-0.5 border border-emerald-500 text-emerald-700 dark:text-emerald-400 text-xs font-medium rounded-full flex items-center gap-1">
                                            <Star className="w-3 h-3" />
                                            基本のメニュー（期間メニューの表示中は控え）
                                        </span>
                                    )}
                                    {hasPeriod && (
                                        <span className="px-2 py-0.5 bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300 text-xs font-medium rounded-full flex items-center gap-1">
                                            <CalendarClock className="w-3 h-3" />
                                            {formatMenuDate(menu.display_period_start)}〜{formatMenuDate(menu.display_period_end)}
                                        </span>
                                    )}
                                    {linkedTags.map(tag => (
                                        <span
                                            key={tag.id}
                                            className="px-2 py-0.5 text-xs font-medium rounded-full flex items-center gap-1 border"
                                            style={{ borderColor: tag.color, color: tag.color }}
                                        >
                                            <TagIcon className="w-3 h-3" />
                                            {tag.name}
                                        </span>
                                    ))}
                                    {!inUse && (
                                        <span className="px-2 py-0.5 bg-slate-100 text-slate-500 dark:bg-slate-800 text-xs rounded-full">
                                            未使用
                                        </span>
                                    )}
                                </div>

                                {/* ワンタッチ操作 */}
                                <div className="flex flex-col sm:flex-row gap-2">
                                    {menu.is_default ? (
                                        <Button size="sm" variant="outline" className="flex-1" disabled>
                                            <Star className="w-4 h-4" />
                                            全員向けに設定中
                                        </Button>
                                    ) : (
                                        <Button
                                            size="sm"
                                            className="flex-1"
                                            onClick={() => handleSetDefault(menu.id)}
                                            disabled={applying || !menu.image_url}
                                        >
                                            {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Users className="w-4 h-4" />}
                                            全員にこれを使う
                                        </Button>
                                    )}
                                    {assignableTags.length > 0 && (
                                        <select
                                            value=""
                                            onChange={(e) => {
                                                if (e.target.value) handleSetTagMenu(e.target.value, menu.id)
                                            }}
                                            disabled={applying || !menu.image_url}
                                            className="flex-1 h-9 px-3 rounded-lg border border-slate-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900"
                                        >
                                            <option value="">＋ タグの人に使う…</option>
                                            {assignableTags.map(tag => {
                                                const current = tag.linked_rich_menu_id
                                                    ? richMenus.find(m => m.id === tag.linked_rich_menu_id)
                                                    : null
                                                return (
                                                    <option key={tag.id} value={tag.id}>
                                                        {tag.name}{current ? `（今:${current.name}）` : ''}
                                                    </option>
                                                )
                                            })}
                                        </select>
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    )
                })}
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
