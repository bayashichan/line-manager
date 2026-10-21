/**
 * LINE表示名の扱い（クライアント・サーバー共通。node専用の処理は入れない）。
 */

/** プロフィールを取れないまま友だちを新しく登録したときの仮の表示名 */
export const UNKNOWN_DISPLAY_NAME = '不明なユーザー'

/** 表示名として使える名前か（未設定・空白だけ・仮の表示名は使えない） */
export function isKnownDisplayName(name: string | null | undefined): name is string {
    return !!name && name.trim() !== '' && name !== UNKNOWN_DISPLAY_NAME
}
