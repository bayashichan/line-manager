import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Tailwind CSSクラスのマージユーティリティ
 */
export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs))
}

/**
 * 日付をフォーマット
 */
export function formatDate(date: string | Date, options?: Intl.DateTimeFormatOptions): string {
    const d = typeof date === 'string' ? new Date(date) : date
    return d.toLocaleDateString('ja-JP', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        ...options,
    })
}

/**
 * 日時をフォーマット
 */
export function formatDateTime(date: string | Date): string {
    const d = typeof date === 'string' ? new Date(date) : date
    return d.toLocaleString('ja-JP', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    })
}

/**
 * 相対時間を取得
 */
export function getRelativeTime(date: string | Date): string {
    const d = typeof date === 'string' ? new Date(date) : date
    const now = new Date()
    const diff = now.getTime() - d.getTime()

    const minutes = Math.floor(diff / 60000)
    const hours = Math.floor(diff / 3600000)
    const days = Math.floor(diff / 86400000)

    if (minutes < 1) return 'たった今'
    if (minutes < 60) return `${minutes}分前`
    if (hours < 24) return `${hours}時間前`
    if (days < 7) return `${days}日前`

    return formatDate(d)
}

/**
 * ステップ配信のタイミングを人間が読みやすい形式に変換
 */
export function formatDelayMinutes(minutes: number, sendHour?: number | null, sendMinute?: number): string {
    if (minutes === 0 && (sendHour === null || sendHour === undefined)) return '即時'

    const days = Math.floor(minutes / 1440)
    const min = sendMinute ?? 0
    const timeStr = sendHour !== null && sendHour !== undefined
        ? `${sendHour}:${min.toString().padStart(2, '0')}`
        : ''

    if (days === 0 && timeStr) return `当日 ${timeStr}`
    if (days === 0) {
        if (minutes < 60) return `${minutes}分後`
        return `${Math.floor(minutes / 60)}時間後`
    }

    return timeStr ? `${days}日後 ${timeStr}` : `${days}日後`
}

/**
 * 次の送信時刻を計算（JST基準）
 * @param triggerTime トリガー発火時刻
 * @param delayMinutes 遅延（分）※日数指定の場合は1440の倍数
 * @param sendHour 送信時刻（0-23、JST）。nullの場合は即時
 * @param sendMinute 送信分（0-59、JST）。デフォルト0
 */
export function calculateNextSendAt(
    triggerTime: Date,
    delayMinutes: number,
    sendHour: number | null,
    sendMinute: number = 0
): string {
    if (sendHour === null || sendHour === undefined) {
        // 従来の即時送信モード（delay_minutes基準）
        return new Date(triggerTime.getTime() + delayMinutes * 60000).toISOString()
    }

    // JST基準で日付計算（UTC+9）
    const jstOffset = 9 * 60 * 60 * 1000
    const triggerJST = new Date(triggerTime.getTime() + jstOffset)

    // トリガー日のJST 0:00を基準にdelay_days日後
    const delayDays = Math.floor(delayMinutes / 1440)
    const targetDateJST = new Date(triggerJST)
    targetDateJST.setUTCHours(0, 0, 0, 0)
    targetDateJST.setUTCDate(targetDateJST.getUTCDate() + delayDays)

    // 指定時刻をセット（JST）
    targetDateJST.setUTCHours(sendHour, sendMinute, 0, 0)

    // UTCに戻す
    const targetUTC = new Date(targetDateJST.getTime() - jstOffset)

    // もし計算結果が過去なら、翌日にずらす
    if (targetUTC <= triggerTime) {
        targetUTC.setUTCDate(targetUTC.getUTCDate() + 1)
    }

    return targetUTC.toISOString()
}

/**
 * 遅延実行（Promise）
 */
export function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 配列をチャンクに分割
 */
export function chunk<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size))
    }
    return chunks
}

/**
 * Cookieを取得
 */
export function getCookie(name: string): string | null {
    if (typeof document === 'undefined') return null
    const value = `; ${document.cookie}`
    const parts = value.split(`; ${name}=`)
    if (parts.length === 2) return parts.pop()?.split(';').shift() || null
    return null
}
