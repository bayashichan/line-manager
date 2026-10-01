import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * DB（Supabase）と LINE API を手元の偽物に置き換えて、
 * 「設定を変えたら LINE 上で実際に誰に何が表示されるか」を確かめる。
 */

type Row = Record<string, unknown>
type Tables = Record<string, Row[]>

const db: { tables: Tables } = { tables: {} }

/** テストで使う範囲だけを実装した Supabase のクエリビルダー */
class FakeQuery {
    private filters: ((row: Row) => boolean)[] = []
    private op: 'select' | 'update' | 'delete' = 'select'
    private payload: Row = {}
    private returning = false
    private mode: 'many' | 'single' | 'maybeSingle' = 'many'
    private range_: [number, number] | null = null

    constructor(private table: string) { }

    select() {
        if (this.op !== 'select') this.returning = true
        return this
    }
    update(payload: Row) {
        this.op = 'update'
        this.payload = payload
        return this
    }
    delete() {
        this.op = 'delete'
        return this
    }
    eq(column: string, value: unknown) {
        this.filters.push(row => row[column] === value)
        return this
    }
    neq(column: string, value: unknown) {
        this.filters.push(row => row[column] !== value)
        return this
    }
    is(column: string, value: unknown) {
        this.filters.push(row => (row[column] ?? null) === value)
        return this
    }
    in(column: string, values: unknown[]) {
        this.filters.push(row => values.includes(row[column]))
        return this
    }
    not(column: string, operator: string, value: unknown) {
        if (operator === 'is') {
            this.filters.push(row => (row[column] ?? null) !== value)
        } else if (operator === 'in') {
            const values = String(value).replace(/^\(|\)$/g, '').split(',')
            this.filters.push(row => !values.includes(String(row[column])))
        }
        return this
    }
    or(expression: string) {
        const conditions = expression.split(',').map(part => {
            const [column, operator, value] = part.split('.')
            if (operator === 'is' && value === 'null') return (row: Row) => (row[column] ?? null) === null
            if (operator === 'eq') return (row: Row) => String(row[column]) === value
            if (operator === 'not') return (row: Row) => (row[column] ?? null) !== null
            throw new Error(`未対応の or 条件: ${part}`)
        })
        this.filters.push(row => conditions.some(c => c(row)))
        return this
    }
    order() {
        return this
    }
    range(from: number, to: number) {
        this.range_ = [from, to]
        return this
    }
    single() {
        this.mode = 'single'
        return this
    }
    maybeSingle() {
        this.mode = 'maybeSingle'
        return this
    }

    then<T>(resolve: (value: { data: unknown; error: unknown }) => T) {
        return Promise.resolve(this.execute()).then(resolve)
    }

    private execute(): { data: unknown; error: unknown } {
        const table = db.tables[this.table] ?? []
        let rows = table.filter(row => this.filters.every(f => f(row)))

        if (this.op === 'update') {
            rows.forEach(row => Object.assign(row, this.payload))
            return { data: this.returning ? rows.map(r => ({ ...r })) : null, error: null }
        }
        if (this.op === 'delete') {
            db.tables[this.table] = table.filter(row => !rows.includes(row))
            return { data: null, error: null }
        }

        rows = [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)))
        if (this.range_) rows = rows.slice(this.range_[0], this.range_[1] + 1)
        const data = rows.map(r => ({ ...r }))

        if (this.mode === 'many') return { data, error: null }
        if (data.length === 0 && this.mode === 'single') return { data: null, error: { message: 'not found' } }
        return { data: data[0] ?? null, error: null }
    }
}

vi.mock('@/lib/supabase/server', () => ({
    createAdminClient: () => ({ from: (table: string) => new FakeQuery(table) }),
}))

/** 偽の LINE。誰に何が表示されるかを持つ */
const line = {
    menus: new Set<string>(),
    defaultMenu: null as string | null,
    links: new Map<string, string>(),
    created: 0,
    calls: [] as string[],
}

/** LINE のアプリで実際に表示されるメニュー（個別リンク ＞ デフォルト） */
const shownTo = (lineUserId: string) => line.links.get(lineUserId) ?? line.defaultMenu

/** 2500x1686 の PNG（ヘッダーだけ） */
function fakePng(): Uint8Array<ArrayBuffer> {
    const buffer = Buffer.alloc(64)
    buffer.writeUInt32BE(0x89504e47, 0)
    buffer.writeUInt32BE(0x0d0a1a0a, 4)
    buffer.writeUInt32BE(13, 8)
    buffer.write('IHDR', 12)
    buffer.writeUInt32BE(2500, 16)
    buffer.writeUInt32BE(1686, 20)
    return new Uint8Array(buffer)
}

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : null

    if (url.startsWith('https://img.example.com/')) {
        return new Response(fakePng(), { status: 200, headers: { 'Content-Type': 'image/png' } })
    }

    const path = url.replace('https://api.line.me/v2/bot', '').replace('https://api-data.line.me/v2/bot', '')
    line.calls.push(`${method} ${path}`)
    let m: RegExpMatchArray | null

    if (method === 'POST' && path === '/richmenu') {
        const id = `line-menu-${++line.created}`
        line.menus.add(id)
        return json({ richMenuId: id })
    }
    if (method === 'POST' && (m = path.match(/^\/richmenu\/([^/]+)\/content$/))) {
        return json({})
    }
    if (method === 'GET' && (m = path.match(/^\/richmenu\/([^/]+)$/))) {
        return line.menus.has(m[1]) ? json({ richMenuId: m[1] }) : json({ message: 'not found' }, 404)
    }
    if (method === 'DELETE' && (m = path.match(/^\/richmenu\/([^/]+)$/))) {
        if (!line.menus.delete(m[1])) return json({ message: 'not found' }, 404)
        // LINE は消したメニューの個別リンク・デフォルト設定も外す
        for (const [user, menu] of line.links) if (menu === m[1]) line.links.delete(user)
        if (line.defaultMenu === m[1]) line.defaultMenu = null
        return json({})
    }
    if (path === '/user/all/richmenu') {
        if (method === 'GET') return line.defaultMenu ? json({ richMenuId: line.defaultMenu }) : json({}, 404)
        if (method === 'DELETE') {
            line.defaultMenu = null
            return json({})
        }
    }
    if (method === 'POST' && (m = path.match(/^\/user\/all\/richmenu\/([^/]+)$/))) {
        if (!line.menus.has(m[1])) return json({ message: 'not found' }, 400)
        line.defaultMenu = m[1]
        return json({})
    }
    if (method === 'POST' && path === '/richmenu/bulk/link') {
        if (!line.menus.has(body.richMenuId)) return json({ message: 'not found' }, 400)
        // 退会した人のIDが混ざっていると、まとめて断られる
        if (body.userIds.includes('U-gone')) return json({ message: 'invalid user' }, 400)
        for (const user of body.userIds) line.links.set(user, body.richMenuId)
        return json({}, 202)
    }
    if (method === 'POST' && path === '/richmenu/bulk/unlink') {
        for (const user of body.userIds) line.links.delete(user)
        return json({}, 202)
    }
    if ((m = path.match(/^\/user\/([^/]+)\/richmenu\/([^/]+)$/)) && method === 'POST') {
        if (m[1] === 'U-gone') return json({ message: 'invalid user' }, 400)
        line.links.set(m[1], m[2])
        return json({})
    }
    if ((m = path.match(/^\/user\/([^/]+)\/richmenu$/)) && method === 'DELETE') {
        line.links.delete(m[1])
        return json({})
    }
    throw new Error(`想定外のLINE API呼び出し: ${method} ${path}`)
}

const { syncChannelRichMenus, syncScheduledRichMenus, saveRichMenuRules } = await import('./sync')
const { createAdminClient } = await import('@/lib/supabase/server')

const richMenu = (id: string, overrides: Row = {}): Row => ({
    id,
    channel_id: 'ch1',
    name: id,
    rich_menu_id: null,
    image_url: `https://img.example.com/${id}.png`,
    areas: [{ bounds: { x: 0, y: 0, width: 2500, height: 1686 }, action: { type: 'message', text: 'hi' } }],
    is_default: false,
    display_period_start: null,
    display_period_end: null,
    created_at: '2026-09-01T00:00:00Z',
    ...overrides,
})

const menuRow = (id: string) => db.tables.rich_menus.find(r => r.id === id)!
const userRow = (id: string) => db.tables.line_users.find(r => r.id === id)!

beforeEach(() => {
    vi.stubGlobal('fetch', fakeFetch)
    line.menus = new Set(['line-old-main'])
    line.defaultMenu = 'line-old-main'
    // 以前の仕組みでは、友だち追加時に基本のメニューを「個別に」付けていた（DBには記録なし）
    line.links = new Map([['U-plain', 'line-old-main'], ['U-vip', 'line-old-main']])
    line.created = 0
    line.calls = []

    db.tables = {
        channels: [{ id: 'ch1', channel_access_token: 'token', default_rich_menu_id: 'main' }],
        rich_menus: [
            richMenu('main', { is_default: true, rich_menu_id: 'line-old-main' }),
            richMenu('autumn'),
            richMenu('vip-menu'),
        ],
        tags: [{ id: 'tag-vip', channel_id: 'ch1', linked_rich_menu_id: 'vip-menu', priority: 10 }],
        line_users: [
            { id: 'plain', channel_id: 'ch1', line_user_id: 'U-plain', current_rich_menu_id: null, is_blocked: false },
            { id: 'vip', channel_id: 'ch1', line_user_id: 'U-vip', current_rich_menu_id: null, is_blocked: false },
            { id: 'blocked', channel_id: 'ch1', line_user_id: 'U-blocked', current_rich_menu_id: null, is_blocked: true },
        ],
        line_user_tags: [{ id: 'ut1', line_user_id: 'vip', tag_id: 'tag-vip' }],
    }
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

describe('syncChannelRichMenus', () => {
    it('全員向けを切り替えると、以前個別に付けていた人も含めて全員がすぐ切り替わる', async () => {
        await saveRichMenuRules(createAdminClient(), 'ch1', { defaultMenuId: 'autumn' })
        const result = await syncChannelRichMenus('ch1', { force: true })

        const autumnLineId = menuRow('autumn').rich_menu_id as string
        expect(autumnLineId).toBeTruthy()
        expect(line.defaultMenu).toBe(autumnLineId)
        // 個別リンクが残っていた人も外れて、新しい全員向けが表示される（解除→再登録は不要）
        expect(shownTo('U-plain')).toBe(autumnLineId)
        // タグの人はタグのメニュー（未登録だったものも自動で LINE に反映される）
        expect(shownTo('U-vip')).toBe(menuRow('vip-menu').rich_menu_id)

        expect(result.allUsersMenu).toMatchObject({ id: 'autumn', reason: 'default' })
        expect(db.tables.rich_menus.filter(r => r.is_default).map(r => r.id)).toEqual(['autumn'])
        expect(db.tables.channels[0].default_rich_menu_id).toBe('autumn')
        expect(userRow('vip').current_rich_menu_id).toBe('vip-menu')
        expect(userRow('plain').current_rich_menu_id).toBeNull()
        // ブロック中の人には送らない
        expect(line.calls.some(c => c.includes('U-blocked'))).toBe(false)
    })

    it('使用中のメニューを編集すると、LINE上で作り直して付け替え、古い版は消す', async () => {
        await syncChannelRichMenus('ch1', { force: true })
        const before = menuRow('vip-menu').rich_menu_id as string

        await syncChannelRichMenus('ch1', { editedMenuIds: ['vip-menu', 'main'] })

        const after = menuRow('vip-menu').rich_menu_id as string
        expect(after).not.toBe(before)
        expect(shownTo('U-vip')).toBe(after)
        expect(line.menus.has(before)).toBe(false)
        // 全員向けも新しい版に切り替わり、古い版は消える
        expect(line.defaultMenu).toBe(menuRow('main').rich_menu_id)
        expect(line.menus.has('line-old-main')).toBe(false)
        expect(shownTo('U-plain')).toBe(menuRow('main').rich_menu_id)
    })

    it('タグのメニュー設定を外すと、すでにタグが付いている人も全員向けに戻る', async () => {
        await syncChannelRichMenus('ch1', { force: true })
        expect(shownTo('U-vip')).toBe(menuRow('vip-menu').rich_menu_id)

        await saveRichMenuRules(createAdminClient(), 'ch1', { tagMenus: [{ tagId: 'tag-vip', menuId: null }] })
        await syncChannelRichMenus('ch1')

        expect(shownTo('U-vip')).toBe(line.defaultMenu)
        expect(userRow('vip').current_rich_menu_id).toBeNull()
    })

    it('LINE側で消されていたメニューは作り直して表示を戻す', async () => {
        await syncChannelRichMenus('ch1', { force: true })
        line.menus.delete(menuRow('main').rich_menu_id as string)
        line.defaultMenu = null

        await syncChannelRichMenus('ch1')

        expect(line.defaultMenu).toBe(menuRow('main').rich_menu_id)
        expect(line.menus.has(line.defaultMenu!)).toBe(true)
    })

    it('画像の条件を満たさないメニューは理由を返し、ほかの反映は続ける', async () => {
        menuRow('vip-menu').image_url = null
        const result = await syncChannelRichMenus('ch1', { force: true })

        expect(result.failedMenus.map(m => m.id)).toEqual(['vip-menu'])
        expect(result.warnings[0]).toContain('vip-menu')
        // 付けられないタグメニューの人は全員向けを表示
        expect(shownTo('U-vip')).toBe('line-old-main')
        expect(shownTo('U-plain')).toBe('line-old-main')
    })

    it('一括送信が一部の人のせいで断られても、ほかの人には1人ずつ送って切り替える', async () => {
        db.tables.line_users.push({ id: 'gone', channel_id: 'ch1', line_user_id: 'U-gone', current_rich_menu_id: null, is_blocked: false })
        db.tables.line_user_tags.push({ id: 'ut2', line_user_id: 'gone', tag_id: 'tag-vip' })

        const result = await syncChannelRichMenus('ch1', { force: true })

        expect(shownTo('U-vip')).toBe(menuRow('vip-menu').rich_menu_id)
        expect(result.linked).toBe(1)
        expect(result.failed).toBe(1)
        expect(userRow('gone').current_rich_menu_id).toBeNull()
        expect(result.warnings.some(w => w.includes('1人'))).toBe(true)
    })

    it('全員向けを「なし」にすると、このツールで設定したデフォルトを外す', async () => {
        await saveRichMenuRules(createAdminClient(), 'ch1', { defaultMenuId: null })
        await syncChannelRichMenus('ch1', { force: true })

        expect(line.defaultMenu).toBeNull()
        expect(db.tables.rich_menus.some(r => r.is_default)).toBe(false)
    })

    it('編集画面でまとめて指定したタグだけがそのメニューを使う', async () => {
        db.tables.tags.push({ id: 'tag-new', channel_id: 'ch1', linked_rich_menu_id: null, priority: 0 })

        await saveRichMenuRules(createAdminClient(), 'ch1', { menuTags: { menuId: 'vip-menu', tagIds: ['tag-new'] } })

        expect(db.tables.tags.find(t => t.id === 'tag-vip')!.linked_rich_menu_id).toBeNull()
        expect(db.tables.tags.find(t => t.id === 'tag-new')!.linked_rich_menu_id).toBe('vip-menu')
    })
})

describe('syncScheduledRichMenus', () => {
    it('表示期間に入ると全員向けを期間メニューにし、終わると基本のメニューに戻す', async () => {
        Object.assign(menuRow('autumn'), {
            display_period_start: '2026-10-01T00:00:00Z',
            display_period_end: '2026-10-31T00:00:00Z',
        })
        vi.useFakeTimers({ toFake: ['Date'] })

        vi.setSystemTime(new Date('2026-09-30T12:00:00Z'))
        expect(await syncScheduledRichMenus()).toEqual([])
        expect(line.defaultMenu).toBe('line-old-main')

        vi.setSystemTime(new Date('2026-10-01T00:05:00Z'))
        const started = await syncScheduledRichMenus()
        expect(started).toEqual([{ channelId: 'ch1', action: 'period_menu_applied', menuName: 'autumn' }])
        expect(line.defaultMenu).toBe(menuRow('autumn').rich_menu_id)

        // 同じ状態なら何もしない（何度呼んでも安全）
        expect(await syncScheduledRichMenus()).toEqual([])

        vi.setSystemTime(new Date('2026-10-31T00:05:00Z'))
        const ended = await syncScheduledRichMenus()
        expect(ended).toEqual([{ channelId: 'ch1', action: 'default_menu_applied', menuName: 'main' }])
        expect(line.defaultMenu).toBe('line-old-main')
    })
})
