import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'

export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params

    if (!id) {
        return NextResponse.json(
            { error: 'IDが指定されていません' },
            { status: 400 }
        )
    }

    const supabase = createAdminClient()

    try {
        // 1. 存在確認
        const { data: user, error: fetchError } = await supabase
            .from('line_users')
            .select('id, display_name')
            .eq('id', id)
            .single()

        if (fetchError || !user) {
            return NextResponse.json(
                { error: 'ユーザーが見つかりません' },
                { status: 404 }
            )
        }

        // 2. 関連データの削除
        // Step Executions
        const { error: stepError } = await supabase
            .from('step_executions')
            .delete()
            .eq('line_user_id', id)

        if (stepError) throw stepError

        // Tags
        const { error: tagError } = await supabase
            .from('line_user_tags')
            .delete()
            .eq('line_user_id', id)

        if (tagError) throw tagError

        // Chat Messages
        const { error: chatError } = await supabase
            .from('chat_messages')
            .delete()
            .eq('line_user_id', id)

        if (chatError) throw chatError

        // 3. ユーザー本体の削除
        const { error: deleteError } = await supabase
            .from('line_users')
            .delete()
            .eq('id', id)

        if (deleteError) {
            throw deleteError
        }

        return NextResponse.json({
            success: true,
            message: `ユーザー「${user.display_name}」を削除しました`
        })

    } catch (error: any) {
        console.error('削除エラー:', error)
        return NextResponse.json(
            { error: '削除処理に失敗しました: ' + (error.message || 'Unknown error') },
            { status: 500 }
        )
    }
}
