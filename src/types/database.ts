// =============================================================================
// データベース型定義
// =============================================================================

export interface Profile {
    id: string
    email: string
    display_name: string | null
    created_at: string
    updated_at: string
}

export interface Channel {
    id: string
    name: string
    channel_id: string
    channel_secret: string
    channel_access_token: string
    webhook_url: string | null
    lmessage_webhook_url: string | null // 追加: LMessage Webhook URL
    default_rich_menu_id: string | null
    auto_reply_tags: string[] | null
    access_password?: string | null // 追加: アクセスパスワード（ハッシュ）
    created_by?: string | null // 追加: 作成者ID
    created_at: string
    updated_at: string
}

export interface ChannelMember {
    id: string
    channel_id: string
    profile_id: string
    role: 'owner' | 'admin'
    created_at: string
}

export interface RichMenu {
    id: string
    channel_id: string
    rich_menu_id: string | null
    name: string
    image_url: string | null
    areas: RichMenuArea[]
    is_default: boolean
    is_active: boolean
    display_period_start: string | null
    display_period_end: string | null
    created_at: string
    updated_at: string
}

export interface RichMenuArea {
    bounds: {
        x: number
        y: number
        width: number
        height: number
    }
    action: {
        type: 'uri' | 'message' | 'postback'
        uri?: string
        text?: string
        data?: string
        label?: string
    }
}

export interface Tag {
    id: string
    channel_id: string
    name: string
    color: string
    linked_rich_menu_id: string | null
    priority: number
    created_at: string
    updated_at: string
}

export interface LineUser {
    id: string
    channel_id: string
    line_user_id: string
    display_name: string | null
    internal_name: string | null
    picture_url: string | null
    status_message: string | null
    is_blocked: boolean
    current_rich_menu_id: string | null
    followed_at: string
    /** 最後にトークを開いたと推定できる日時（みなし既読の基準） */
    last_read_at?: string | null
    created_at: string
    updated_at: string
}

export interface LineUserTag {
    id: string
    line_user_id: string
    tag_id: string
    assigned_at: string
}

export interface Message {
    id: string
    channel_id: string
    title: string
    content: MessageContent[]
    status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed' | 'cancelled'
    qstash_message_id?: string | null
    filter_tags: string[] | null
    exclude_tags: string[] | null
    scheduled_at: string | null
    sent_at: string | null
    total_recipients: number
    success_count: number
    failure_count: number
    /** 配信失敗時の理由（LINE APIのエラー本文など） */
    error_message?: string | null
    created_at: string
    updated_at: string
}

export interface MessageContent {
    type: 'text' | 'image' | 'video' | 'flex'
    text?: string
    originalContentUrl?: string
    previewImageUrl?: string
    altText?: string
    contents?: object // Flex Message
    /** 画像の横縦比（width / height）。Flex Messageのアスペクト比に変換して使う */
    aspectRatio?: number
    /** 旧仕様: 画像タップ時に開くURL */
    linkUrl?: string
    customActions?: {
        tagIds?: string[]
        scenarioId?: string
        replyText?: string
        redirectUrl?: string
    }
}

export interface MessageRecipient {
    id: string
    message_id: string
    line_user_id: string
    status: 'pending' | 'sent' | 'failed'
    error_message: string | null
    sent_at: string | null
    /**
     * みなし既読の日時。LINEは既読を通知しないため、配信後に友だちから反応
     * （返信・ボタン操作・リンクタップ）があった時点でセットされる。
     * null は「読んでいない」ではなく「反応が確認できていない」を意味する。
     */
    read_at?: string | null
    /** 既読と判断した根拠: message | postback | link_click | other */
    read_source?: string | null
}

export interface ChatMessage {
    id: string
    channel_id: string
    /** line_users.id（内部UUID） */
    line_user_id: string
    sender: 'user' | 'admin'
    content_type: string
    content: Record<string, unknown>
    read_at: string | null
    read_source?: string | null
    /** 管理者側: chat | broadcast | step | auto_reply / 友だち側: line */
    delivery_source?: string | null
    /** 一斉配信由来の場合の messages.id */
    message_id?: string | null
    /** LINE側のメッセージID（受信の重複防止・送信取消の突き合わせ用） */
    line_message_id?: string | null
    /** 友だちが送信を取り消した日時 */
    unsent_at?: string | null
    created_at: string
}

export interface StepScenario {
    id: string
    channel_id: string
    name: string
    trigger_type: 'follow' | 'tag_assigned'
    trigger_tag_id: string | null
    is_active: boolean
    created_at: string
    updated_at: string
}

export interface StepMessage {
    id: string
    scenario_id: string
    step_order: number
    delay_minutes: number
    send_hour: number | null
    send_minute: number
    content: MessageContent[]
    created_at: string
    updated_at: string
}

export interface StepExecution {
    id: string
    scenario_id: string
    line_user_id: string
    current_step: number
    status: 'active' | 'completed' | 'cancelled'
    next_send_at: string | null
    started_at: string
    completed_at: string | null
}

// =============================================================================
// 申込フォーム
// =============================================================================

export type FormFieldType =
    | 'text'
    | 'textarea'
    | 'email'
    | 'tel'
    | 'number'
    | 'date'
    | 'select'
    | 'radio'
    | 'checkbox'

export interface FormField {
    id: string
    label: string
    type: FormFieldType
    required: boolean
    placeholder?: string
    options?: string[] // select / radio / checkbox 用
}

export interface Form {
    id: string
    channel_id: string
    name: string
    title: string | null
    description: string | null
    fields: FormField[]
    completion_message: MessageContent[] // 完了時の自動返信（テキスト/画像）
    completion_tag_ids: string[] | null
    is_active: boolean
    created_at: string
    updated_at: string
}

export interface FormResponse {
    id: string
    form_id: string
    channel_id: string
    line_user_id: string | null
    line_user_id_raw: string | null
    answers: Record<string, string | string[]>
    created_at: string
}

// =============================================================================
// キーワード自動応答
// =============================================================================

export type AutoReplyMatchType = 'exact' | 'partial'

/**
 * キーワード自動応答の定義。
 *
 * 送信は Messaging API の応答（Reply）APIで行う。応答メッセージはLINEの
 * メッセージ通数にカウントされないため、この機能での返信は送信枠を消費しない。
 */
export interface AutoReply {
    id: string
    channel_id: string
    name: string
    keywords: string[]
    match_type: AutoReplyMatchType
    content: MessageContent[]
    priority: number
    is_active: boolean
    created_at: string
    updated_at: string
}

// =============================================================================
// リレーション付き型
// =============================================================================

export interface LineUserWithTags extends LineUser {
    tags: Tag[]
}

/**
 * 外部の申込フォームから連携された申込者。
 * is_friend が false = 申込は済んでいるが公式アカウントの友だちではない人。
 */
export interface Applicant {
    id: string
    channel_id: string
    line_user_id: string
    display_name: string | null
    source: string
    is_friend: boolean
    linked_line_user_id: string | null
    applied_at: string | null
    created_at: string
    updated_at: string
}

export interface ChannelWithMembers extends Channel {
    members: (ChannelMember & { profile: Profile })[]
}

export interface TagWithRichMenu extends Tag {
    rich_menu: RichMenu | null
}

export interface StepScenarioWithMessages extends StepScenario {
    messages: StepMessage[]
}
