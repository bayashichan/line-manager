/**
 * 4C創造性チェック（updatehayashi.jp/4c/）の結果を、友だちのタグに変換する。
 *
 * 「4C診断済み」タグを作ってあるチャンネルだけが対象になる（そのタグが、受け取る側の目印）。
 * 段階・差・ブレーキのタグは、診断し直したときに古いものを外して付け直す。
 */

/** 受け取る側の目印。このタグがあるチャンネルの友だちにだけ結果を付ける */
export const FOUR_C_MARKER_TAG = '4C診断済み'

export const FOUR_C_STAGE_TAGS = {
    asleep: '4C_ミニc（眠っている）',
    mini: '4C_ミニc（育っている）',
    little: '4C_リトルc',
    pro: '4C_プロc',
} as const

export type FourCStage = keyof typeof FOUR_C_STAGE_TAGS

export const FOUR_C_GAP_TAG = '4C_差2段階以上'
export const FOUR_C_BRAKE_TAG = '4C_ブレーキあり'

/** 診断し直したときに外す対象（目印のタグは外さない） */
export const FOUR_C_RESULT_TAGS: string[] = [...Object.values(FOUR_C_STAGE_TAGS), FOUR_C_GAP_TAG, FOUR_C_BRAKE_TAG]

export interface FourCResult {
    stage: FourCStage
    /** 目指している段階（0: ミニc 〜 3: ビッグC） */
    goal: number
    brake: boolean
}

const STAGE_INDEX: Record<FourCStage, number> = { asleep: 0, mini: 0, little: 1, pro: 2 }

/** 送られてきた本文を確かめる。おかしければ null */
export function parseFourCResult(body: unknown): FourCResult | null {
    if (!body || typeof body !== 'object') return null
    const { stage, goal, brake } = body as Record<string, unknown>
    if (typeof stage !== 'string' || !(stage in FOUR_C_STAGE_TAGS)) return null
    if (typeof goal !== 'number' || !Number.isInteger(goal) || goal < 0 || goal > 3) return null
    if (typeof brake !== 'boolean') return null
    return { stage: stage as FourCStage, goal, brake }
}

/** この結果で付けるタグ名（目印のタグを含む） */
export function fourCTagNames(result: FourCResult): string[] {
    const names = [FOUR_C_MARKER_TAG, FOUR_C_STAGE_TAGS[result.stage]]
    if (result.goal - STAGE_INDEX[result.stage] >= 2) names.push(FOUR_C_GAP_TAG)
    if (result.brake) names.push(FOUR_C_BRAKE_TAG)
    return names
}

/** 診断ページを置いているオリジン（CORS で許可する） */
export function isAllowedFourCOrigin(origin: string | null): boolean {
    if (!origin) return false
    return origin === 'https://updatehayashi.jp' || /^https:\/\/[a-z0-9-]+\.voiceanalysis-ce1\.pages\.dev$/.test(origin)
}
