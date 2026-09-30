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
    description?: string // 質問の下に表示する補足説明
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
    // 残席設定（オフなら定員なし）
    capacity_enabled: boolean
    capacity: number | null
    full_action: FormFullAction // 満席時の動作
    waitlist_message: string | null // キャンセル待ちの自動返信（NULLなら既定の文面）
    waitlist_tag_ids: string[] | null // キャンセル待ちの人に付けるタグ（完了タグの代わり）
    created_at: string
    updated_at: string
}

/**
 * 満席時の動作
 * - waitlist: キャンセル待ちとして受け付ける
 * - close:    申込を締め切る
 */
export type FormFullAction = 'waitlist' | 'close'

/**
 * 申込状態
 * - confirmed:  申込（席を確保した）
 * - waitlisted: キャンセル待ち
 */
export type FormEntryStatus = 'confirmed' | 'waitlisted'

/**
 * 申込完了時の自動返信の送信結果。
 * - pending: 送信処理中。このまま残っていれば途中で止まった（結果不明）
 * - sent:    LINEが送信を受け付けた
 * - failed:  送信に失敗した（理由は completion_reply_error）
 * - skipped: 送らなかった（自動返信が未設定など。理由は completion_reply_error）
 */
export type CompletionReplyStatus = 'pending' | 'sent' | 'failed' | 'skipped'

export interface FormResponse {
    id: string
    form_id: string
    channel_id: string
    line_user_id: string | null
    line_user_id_raw: string | null
    answers: Record<string, string | string[]>
    entry_status: FormEntryStatus
    completion_reply_status: CompletionReplyStatus | null // NULL = 記録なし（機能追加前の回答）
    completion_reply_error: string | null
    completion_reply_at: string | null
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
    internal_name: string | null        // 友だちの管理用ネームに登録する名前（出展名など）
    tag_names: string[]                 // 友だちに付与するタグ名
    profile_applied_at: string | null   // 管理用ネーム・タグを友だちへ反映した日時。NULL = 未反映
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

// =============================================================================
// リマインダー配信（予定の日時を基準にした配信）
// =============================================================================

/** day_time: 予定日の N日前/後 の HH:MM（日本時間） / relative: 予定時刻の N分前/後 */
export type ReminderTimingType = 'day_time' | 'relative'

export interface Reminder {
    id: string
    channel_id: string
    name: string
    is_active: boolean
    send_missed: boolean
    created_at: string
    updated_at: string
}

export interface ReminderStep {
    id: string
    reminder_id: string
    step_order: number
    timing_type: ReminderTimingType
    offset_days: number
    send_hour: number | null
    send_minute: number
    offset_minutes: number
    content: MessageContent[]
    created_at: string
}

export interface FriendReminder {
    id: string
    channel_id: string
    reminder_id: string | null
    line_user_id: string
    target_at: string
    label: string | null
    source: 'manual' | 'booking' | 'mcp'
    status: 'active' | 'completed' | 'cancelled'
    meeting_url: string | null
    created_at: string
}

export interface ReminderDelivery {
    id: string
    friend_reminder_id: string
    step_id: string | null
    step_order: number
    send_at: string
    content: MessageContent[]
    status: 'pending' | 'sending' | 'sent' | 'failed' | 'skipped' | 'cancelled'
    sent_at: string | null
    error_message: string | null
    created_at: string
}

// =============================================================================
// 面談の日程調整
// =============================================================================

export interface BookingSettings {
    channel_id: string
    is_active: boolean
    trigger_keywords: string[]
    offer_count: number
    min_lead_hours: number
    session_label: string
    intro_text: string
    other_label: string
    decline_label: string
    booked_text: string
    other_text: string
    decline_text: string
    no_slots_text: string
    taken_text: string
    nudge_enabled: boolean
    nudge_after_hours: number
    nudge_text: string
    booked_tag_id: string | null
    reminder_id: string | null
    /** 空き枠の作り方。calendar = Googleカレンダーの空き時間から自動で作る */
    slot_source: 'manual' | 'calendar'
    availability: BookingAvailability
    slot_duration_minutes: number
    slot_interval_minutes: number
    buffer_minutes: number
    horizon_days: number
    create_calendar_event: boolean
    add_google_meet: boolean
    updated_at: string
}

/** 受付する曜日（0=日〜6=土）と時間帯（日本時間 "HH:MM"） */
export interface BookingAvailability {
    weekdays: number[]
    start: string
    end: string
}

export interface BookingSlot {
    id: string
    channel_id: string
    start_at: string
    status: 'open' | 'booked' | 'closed'
    line_user_id: string | null
    booked_at: string | null
    source: 'manual' | 'calendar'
    closed_by: 'manual' | 'calendar' | null
    duration_minutes: number | null
    google_event_id: string | null
    meeting_url: string | null
    created_at: string
}

export type BookingOfferStatus = 'pending' | 'booked' | 'other' | 'declined' | 'no_slots' | 'superseded' | 'cancelled'

export interface BookingOffer {
    id: string
    channel_id: string
    line_user_id: string
    status: BookingOfferStatus
    slot_ids: string[]
    booked_slot_id: string | null
    friend_reminder_id: string | null
    responded_at: string | null
    nudged_at: string | null
    answered_at: string | null
    created_at: string
}
