import type { Form } from '@/types'

/**
 * 申込フォームの残席（定員）まわりの共通処理。
 * LIFFのフォーム・管理画面・APIのどこからでも使えるよう、サーバー専用の依存を持たない。
 */

/**
 * 申込の受付状況
 * - open:     席が残っている
 * - waitlist: 満席。キャンセル待ちとして受け付ける
 * - closed:   満席。申込を締め切った
 */
export type FormAvailabilityState = 'open' | 'waitlist' | 'closed'

export interface FormAvailability {
    capacity: number
    remaining: number
    state: FormAvailabilityState
}

/** 残りがこの席数以下になったら「残りわずか」として目立たせる */
export const FEW_SEATS_THRESHOLD = 3

/** キャンセル待ちの自動返信が未設定のときに送る文面 */
export const DEFAULT_WAITLIST_MESSAGE =
    '{name}さん、お申し込みありがとうございます。\n' +
    '定員に達したため、キャンセル待ちとして受け付けました。\n' +
    'お席に空きが出ましたら、あらためてご連絡いたします。'

/**
 * 定員と申込数（キャンセル待ちを除く）から受付状況を求める。
 * 残席設定がオフなら null（定員なし）。
 */
export function computeAvailability(
    form: Pick<Form, 'capacity_enabled' | 'capacity' | 'full_action'>,
    confirmedCount: number
): FormAvailability | null {
    if (!form.capacity_enabled || !form.capacity) return null

    const remaining = Math.max(0, form.capacity - confirmedCount)
    const state: FormAvailabilityState =
        remaining > 0 ? 'open' : form.full_action === 'close' ? 'closed' : 'waitlist'
    return { capacity: form.capacity, remaining, state }
}
