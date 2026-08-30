import type { AutoReply } from '@/types'

/**
 * LINEのテキストメッセージ1件（1吹き出し）に入れられる最大文字数。
 * Messaging APIの制限そのもの。公式アカウントマネージャーの応答メッセージは
 * 500文字までだが、それは管理画面側のUI制限であってAPIの制限ではない。
 */
export const MAX_TEXT_LENGTH = 5000

/** 1リクエストで送れるメッセージオブジェクト（吹き出し）の最大数 */
export const MAX_BLOCKS = 5

/**
 * 比較用にテキストを正規化する。
 * 全角/半角の吸収まではやらない（表記ゆれはキーワードを複数登録して対応する）。
 */
function normalize(text: string): string {
    return text.trim().toLowerCase()
}

/**
 * 受信テキストにマッチする自動応答ルールを1件だけ返す。
 *
 * 複数ルールがマッチしても必ず1件に絞る。複数返すと吹き出しが増えるうえ、
 * 「どのルールが反応したか」が利用者から見て分からなくなるため。
 * 優先度（降順）→ 作成日時（昇順）の順で先勝ちとする。
 *
 * DBアクセスを含まない純関数にしてあるので、呼び出し元で有効な行を取得してから渡すこと。
 */
export function findMatchingAutoReply(
    rules: AutoReply[],
    text: string
): AutoReply | null {
    const target = normalize(text)
    if (!target) return null

    const matched = rules.filter((rule) => {
        if (!rule.is_active) return false
        if (!rule.content || rule.content.length === 0) return false
        return (rule.keywords || []).some((keyword) => {
            const k = normalize(keyword)
            if (!k) return false
            return rule.match_type === 'exact' ? target === k : target.includes(k)
        })
    })

    if (matched.length === 0) return null

    matched.sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority
        return a.created_at.localeCompare(b.created_at)
    })

    return matched[0]
}

/**
 * 応答内容の {name} を表示名に置き換える。
 * 一斉配信（api/messages/send/route.ts）と同じ挙動に揃えてある。
 */
export function personalizeContent<T extends { type: string; text?: string }>(
    content: T[],
    displayName: string | null | undefined
): T[] {
    const name = displayName || '友だち'
    return content.map((block) =>
        block.type === 'text' && block.text
            ? { ...block, text: block.text.replace(/{name}/g, name) }
            : block
    )
}
