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
    status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed'
    filter_tags: string[] | null
    scheduled_at: string | null
    sent_at: string | null
    total_recipients: number
    success_count: number
    failure_count: number
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
// リレーション付き型
// =============================================================================

export interface LineUserWithTags extends LineUser {
    tags: Tag[]
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
