/**
 * 1:1チャットのトーク画面に出す日付の表記（日本時間基準）。
 *
 * メッセージの間に「日付の区切り」を入れて、各メッセージが何日のものか分かるようにする。
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']
const DAY_MS = 24 * 60 * 60 * 1000

/** 日本時間の日付（例: "2026-11-04"）。同じ日かどうかの判定に使う */
export function jstDayKey(date: Date): string {
    return new Date(date.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10)
}

/**
 * 日付の区切りの表記。
 * 例: "11月4日(水) 今日" / "11月3日(火) 昨日" / "10月28日(火)" / 年が違えば "2025年12月31日(水)"
 */
export function formatChatDayLabel(date: Date, now: Date = new Date()): string {
    const jst = new Date(date.getTime() + JST_OFFSET_MS)
    const year = jst.getUTCFullYear()
    const month = jst.getUTCMonth() + 1
    const day = jst.getUTCDate()
    const weekday = WEEKDAYS[jst.getUTCDay()]

    const nowYear = new Date(now.getTime() + JST_OFFSET_MS).getUTCFullYear()
    const base = `${year === nowYear ? '' : `${year}年`}${month}月${day}日(${weekday})`

    const key = jstDayKey(date)
    if (key === jstDayKey(now)) return `${base} 今日`
    if (key === jstDayKey(new Date(now.getTime() - DAY_MS))) return `${base} 昨日`
    return base
}

/** メッセージ横の時刻（例: "09:05"） */
export function formatChatTime(date: Date): string {
    const iso = new Date(date.getTime() + JST_OFFSET_MS).toISOString()
    return iso.slice(11, 16)
}
