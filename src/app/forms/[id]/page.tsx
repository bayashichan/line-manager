'use client'

import { useParams } from 'next/navigation'
import { FormRunner } from '@/components/form-runner'

/**
 * パス形式でのフォーム起動（直接リンク / パス連結方式のLIFF両対応）。
 */
export default function FormByIdPage() {
    const params = useParams<{ id: string }>()
    return <FormRunner formId={params?.id ?? null} />
}
