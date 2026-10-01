/**
 * 面談の日程調整で使う、入力だけで結果が決まる処理。
 * - 候補の選択肢（番号・ラベル）を作る
 * - 番号付きの文面と、タップで選べるボタン（クイックリプライ）を作る
 * - 友だちの返事（「1」「①」「2番」やボタンの文言）から選択肢を読み取る
 * - 「個別」などのキーワードに一致するか判定する
 */

import { fillPlaceholders, formatJstShort } from '@/lib/reminders/timing'

/** LINE のクイックリプライのボタンは最大13個・ラベルは20文字まで */
const QUICK_REPLY_LABEL_MAX = 20
/** LINE のテキストメッセージの最大文字数 */
const TEXT_MAX = 5000

export type OfferOption =
    | { no: number; kind: 'slot'; slotId: string; startAt: Date; label: string; available: boolean }
    | { no: number; kind: 'other'; label: string }
    | { no: number; kind: 'decline'; label: string }

/**
 * 案内した枠から選択肢を作る。番号は 1 から順に、枠 → 別の日程 → 見送る。
 * 番号は案内した時点で固定する（あとで一部の枠が埋まっても番号はずらさない）。
 */
export function buildOfferOptions(
    slots: { id: string; start_at: string; status?: string }[],
    labels: { other: string; decline: string }
): OfferOption[] {
    const slotOptions: OfferOption[] = slots.map((slot, index) => {
        const startAt = new Date(slot.start_at)
        return {
            no: index + 1,
            kind: 'slot',
            slotId: slot.id,
            startAt,
            label: formatJstShort(startAt),
            available: (slot.status ?? 'open') === 'open',
        }
    })
    return [
        ...slotOptions,
        { no: slots.length + 1, kind: 'other', label: labels.other },
        { no: slots.length + 2, kind: 'decline', label: labels.decline },
    ]
}

function optionText(option: OfferOption): string {
    return `${option.no} ${option.label}`
}

/**
 * 番号付きの候補の文面 + タップで選べるボタン（LINE のメッセージオブジェクト）。
 * 埋まった枠は一覧とボタンから外す（番号はそのまま）。
 */
export function buildOfferMessage(
    header: string,
    options: OfferOption[],
    footer = '番号を送るか、下のボタンをタップしてください。'
): Record<string, unknown> {
    const visible = options.filter(o => o.kind !== 'slot' || o.available)
    const lines = visible.map(o => `${o.no}. ${o.label}`)
    const text = [header.trim(), lines.join('\n'), footer].filter(Boolean).join('\n\n').slice(0, TEXT_MAX)

    return {
        type: 'text',
        text,
        quickReply: {
            items: visible.slice(0, 13).map(o => ({
                type: 'action',
                action: {
                    type: 'message',
                    label: optionText(o).slice(0, QUICK_REPLY_LABEL_MAX),
                    text: optionText(o),
                },
            })),
        },
    }
}

/** 比較用の正規化（全角→半角、前後の空白、大文字小文字） */
function normalize(text: string): string {
    return text.normalize('NFKC').trim().toLowerCase()
}

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬'

/**
 * 友だちの返事から選んだ選択肢を読み取る。読み取れなければ null。
 *
 * 受け付ける例: "1" "１" "①" "1番" "1." "1 10/3(金) 10:00"（ボタンの文言）"別の日程を希望"
 * 受け付けない例: "1時間くらいですか？"（番号のあとにラベル以外の文が続く）
 */
export function parseOfferAnswer(text: string, options: OfferOption[]): OfferOption | null {
    if (!text) return null
    const raw = text.trim()
    if (raw.length === 0 || raw.length > 60) return null

    // 丸数字（NFKC で数字になる前に判定）
    const circledIndex = CIRCLED.indexOf(raw[0])
    let numberPart: number | null = null
    let rest = ''
    if (circledIndex >= 0) {
        numberPart = circledIndex + 1
        rest = raw.slice(1)
    } else {
        const match = /^([0-9]{1,2})([\s\S]*)$/.exec(normalize(raw))
        if (match) {
            numberPart = Number(match[1])
            rest = match[2]
        }
    }

    if (numberPart !== null) {
        const option = options.find(o => o.no === numberPart)
        if (!option) return null
        const tail = normalize(rest).replace(/^(番|\.|、|:|\)|\s)+/, '').trim()
        if (tail === '' || tail === normalize(option.label)) return option
        return null
    }

    // 番号なしでラベルそのもの（「別の日程を希望」「今回は見送る」など）
    const target = normalize(raw)
    return options.find(o => normalize(o.label) === target) ?? null
}

/**
 * 「個別」などのキーワードに一致するか。誤反応を避けるため完全一致で判定する
 * （前後の空白と、末尾の「！」「。」などの記号は無視する）。
 */
export function matchesTriggerKeyword(text: string, keywords: string[]): boolean {
    const strip = (value: string) => normalize(value).replace(/[!?.。、,~〜ー\s]+$/u, '')
    const target = strip(text)
    if (!target) return false
    return keywords.some(keyword => {
        const k = strip(keyword)
        return k.length > 0 && k === target
    })
}

/** テンプレート文面の差し込み（{name}・{日時} など） */
export function fillBookingText(
    template: string,
    values: { name?: string | null; target?: Date | null; meetingUrl?: string | null }
): string {
    // {会議URL} が空のときなどに末尾へ残る空行は消す
    return fillPlaceholders(template, values).trimEnd().slice(0, TEXT_MAX)
}
