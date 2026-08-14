/**
 * Supabase (PostgREST) は1リクエストで返す行数に上限があり、既定では1000行で打ち切られる。
 * `.range()` でページングしながら全行を取得するためのヘルパー。
 *
 * 使用時の注意:
 * - buildQuery には必ず「一意に定まる並び順」を含めること（例: `.order('followed_at').order('id')`）。
 *   同値のレコードが複数あると、ページ間で行の重複・欠落が起きるため。
 */
export const SUPABASE_MAX_ROWS = 1000

type PagedResponse<T> = { data: T[] | null; error: unknown }

export async function fetchAllRows<T>(
    buildQuery: (from: number, to: number) => PromiseLike<PagedResponse<T>>,
    pageSize: number = SUPABASE_MAX_ROWS
): Promise<{ data: T[]; error: unknown }> {
    const rows: T[] = []

    for (let from = 0; ; from += pageSize) {
        const { data, error } = await buildQuery(from, from + pageSize - 1)

        if (error) {
            // 途中まで取れた分は返しつつ、エラーも呼び出し元に伝える
            return { data: rows, error }
        }

        if (!data || data.length === 0) break

        rows.push(...data)

        // 1ページ分に満たない = 最終ページ
        if (data.length < pageSize) break
    }

    return { data: rows, error: null }
}
