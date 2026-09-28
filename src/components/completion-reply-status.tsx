import { cn } from '@/lib/utils'
import type { CompletionReplyStatus, FormResponse } from '@/types'

/**
 * 申込完了時の自動返信の送信結果の表示（申込者一覧・回答一覧で共用）。
 */

type ReplyRecord = Pick<FormResponse, 'completion_reply_status' | 'completion_reply_error'>

const LABELS: Record<CompletionReplyStatus, string> = {
    sent: '送信済み',
    failed: '失敗',
    skipped: '未送信',
    pending: '結果不明',
}

const CLASSES: Record<CompletionReplyStatus, string> = {
    sent: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
    failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    skipped: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
    pending: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
}

// 機能追加前の回答には送信結果の記録がない（マイグレーション適用前は列自体がない）
const NO_RECORD_LABEL = '記録なし'

/** CSVなどに出す送信結果の文言 */
export function completionReplyLabel(record: ReplyRecord): string {
    const status = record.completion_reply_status
    return status ? LABELS[status] : NO_RECORD_LABEL
}

/** 送れなかった・届いたか分からないときの説明。送信済み・記録なしのときは null */
export function completionReplyDetail(record: ReplyRecord): string | null {
    switch (record.completion_reply_status) {
        case 'failed':
            return record.completion_reply_error || '送信に失敗しました'
        case 'skipped':
            return record.completion_reply_error || '自動返信を送っていません'
        case 'pending':
            return '送信処理が途中で止まりました。届いていない可能性があります'
        default:
            return null
    }
}

/** 自動返信が届いていないおそれがある（失敗・結果不明）か */
export function isCompletionReplyUndelivered(record: ReplyRecord): boolean {
    return record.completion_reply_status === 'failed' || record.completion_reply_status === 'pending'
}

export function CompletionReplyBadge({ record, className }: { record: ReplyRecord; className?: string }) {
    const status = record.completion_reply_status
    if (!status) return null

    return (
        <span
            className={cn('px-2 py-0.5 text-xs rounded-full whitespace-nowrap', CLASSES[status], className)}
            title={completionReplyDetail(record) ?? 'LINEが自動返信の送信を受け付けました'}
        >
            自動返信: {LABELS[status]}
        </span>
    )
}
