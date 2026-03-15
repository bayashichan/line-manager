'use client'

import { useState, useEffect } from 'react'
import { Card, CardHeader, CardContent, Button, Input } from '@/components/ui'
import { Loader2, Search, XCircle, Clock, CheckCircle2, AlertCircle, ArrowLeft, ListChecks } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { cn, getCookie } from '@/lib/utils'

type Execution = {
    id: string
    current_step: number
    status: 'active' | 'completed' | 'cancelled'
    next_send_at: string | null
    started_at: string
    completed_at: string | null
    step_scenarios: {
        id: string
        name: string
    }
    line_users: {
        id: string
        display_name: string
        picture_url: string | null
    }
}

type Scenario = {
    id: string
    name: string
}

export default function StepExecutionsPage() {
    const router = useRouter()
    const [executions, setExecutions] = useState<Execution[]>([])
    const [scenarios, setScenarios] = useState<Scenario[]>([])
    const [loading, setLoading] = useState(true)

    // フィルタリング状態
    const [statusFilter, setStatusFilter] = useState<string>('all')
    const [scenarioFilter, setScenarioFilter] = useState<string>('all')
    const [searchQuery, setSearchQuery] = useState('')

    useEffect(() => {
        fetchExecutions()
        fetchScenarios()
    }, [statusFilter, scenarioFilter])

    const fetchExecutions = async () => {
        setLoading(true)
        try {
            const params = new URLSearchParams()
            if (statusFilter !== 'all') params.append('status', statusFilter)
            if (scenarioFilter !== 'all') params.append('scenarioId', scenarioFilter)

            const res = await fetch(`/api/step-executions/list?${params.toString()}`)
            if (!res.ok) throw new Error('通信エラー')

            const data = await res.json()
            if (data.executions) {
                setExecutions(data.executions)
            }
        } catch (error) {
            console.error('取得エラー:', error)
        } finally {
            setLoading(false)
        }
    }

    const fetchScenarios = async () => {
        const supabase = createClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return

        const savedChannelId = getCookie('line-manager-channel-id')
        if (!savedChannelId) return

        const { data } = await supabase
            .from('step_scenarios')
            .select('id, name')
            .eq('channel_id', savedChannelId)
            .order('created_at', { ascending: false })

        if (data) {
            setScenarios(data)
        }
    }

    const handleCancel = async (id: string) => {
        if (!confirm('このユーザーのステップ配信を強制停止しますか？\n次回以降のステップメッセージは送信されなくなります。')) return

        try {
            const execution = executions.find(e => e.id === id)
            if (!execution) return

            const res = await fetch('/api/step-executions/stop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    lineUserId: execution.line_users.id,
                    scenarioId: execution.step_scenarios.id
                })
            })

            if (!res.ok) throw new Error('停止処理に失敗しました')

            fetchExecutions()
            alert('配信を停止しました。')
        } catch (error) {
            console.error(error)
            alert('エラーが発生しました')
        }
    }

    // クライアント側での検索フィルタリング
    const filteredExecutions = executions.filter(exec => {
        if (searchQuery) {
            return exec.line_users.display_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                exec.step_scenarios.name?.toLowerCase().includes(searchQuery.toLowerCase())
        }
        return true
    })

    // 統計情報
    const activeCount = executions.filter(e => e.status === 'active').length
    const completedCount = executions.filter(e => e.status === 'completed').length
    const cancelledCount = executions.filter(e => e.status === 'cancelled').length

    const getStatusLabel = (status: string) => {
        switch (status) {
            case 'active': return '配信中'
            case 'completed': return '完了'
            case 'cancelled': return '停止'
            default: return status
        }
    }

    const getStatusColor = (status: string) => {
        switch (status) {
            case 'active': return 'bg-blue-100 text-blue-700 border-blue-200'
            case 'completed': return 'bg-green-100 text-green-700 border-green-200'
            case 'cancelled': return 'bg-gray-100 text-gray-500 border-gray-200'
            default: return 'bg-gray-100 text-gray-600'
        }
    }

    const getStatusIcon = (status: string) => {
        switch (status) {
            case 'active': return <Clock className="w-3 h-3" />
            case 'completed': return <CheckCircle2 className="w-3 h-3" />
            case 'cancelled': return <XCircle className="w-3 h-3" />
            default: return null
        }
    }

    const formatDate = (dateString: string | null) => {
        if (!dateString) return '-'
        try {
            const d = new Date(dateString)
            const y = d.getFullYear()
            const mo = String(d.getMonth() + 1).padStart(2, '0')
            const da = String(d.getDate()).padStart(2, '0')
            const h = String(d.getHours()).padStart(2, '0')
            const mi = String(d.getMinutes()).padStart(2, '0')
            return `${y}/${mo}/${da} ${h}:${mi}`
        } catch {
            return '-'
        }
    }

    return (
        <div className="space-y-6 max-w-6xl mx-auto">
            {/* ヘッダー */}
            <div className="flex items-center gap-4 mb-2">
                <Button variant="ghost" size="icon" onClick={() => router.push('/dashboard/step')}>
                    <ArrowLeft className="w-5 h-5" />
                </Button>
                <div>
                    <h1 className="text-2xl font-bold bg-gradient-to-r from-slate-900 to-slate-700 bg-clip-text text-transparent dark:from-slate-100 dark:to-slate-300">
                        ステップ配信 進行状況
                    </h1>
                    <p className="text-slate-500 dark:text-slate-400 mt-1">
                        各ユーザーごとのシナリオ配信状況や次回の送信予定を確認できます
                    </p>
                </div>
            </div>

            {/* 統計カード */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="flex items-center gap-3 p-4 rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800">
                    <Clock className="w-5 h-5 text-blue-500" />
                    <div>
                        <p className="text-sm text-blue-600 dark:text-blue-400">配信中</p>
                        <p className="text-2xl font-bold text-blue-700 dark:text-blue-300">{activeCount}</p>
                    </div>
                </div>
                <div className="flex items-center gap-3 p-4 rounded-xl bg-green-50 dark:bg-green-900/20 border border-green-100 dark:border-green-800">
                    <CheckCircle2 className="w-5 h-5 text-green-500" />
                    <div>
                        <p className="text-sm text-green-600 dark:text-green-400">完了</p>
                        <p className="text-2xl font-bold text-green-700 dark:text-green-300">{completedCount}</p>
                    </div>
                </div>
                <div className="flex items-center gap-3 p-4 rounded-xl bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-700">
                    <XCircle className="w-5 h-5 text-gray-400" />
                    <div>
                        <p className="text-sm text-gray-500">停止</p>
                        <p className="text-2xl font-bold text-gray-600 dark:text-gray-300">{cancelledCount}</p>
                    </div>
                </div>
            </div>

            {/* フィルタ & テーブル */}
            <Card>
                <CardHeader className="pb-3">
                    <div className="flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center">
                        <div className="relative flex-1 w-full sm:max-w-xs">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                            <Input
                                placeholder="名前やシナリオ名で検索..."
                                className="pl-9"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                            />
                        </div>
                        <div className="flex items-center gap-3 w-full sm:w-auto">
                            <select
                                value={statusFilter}
                                onChange={(e) => setStatusFilter(e.target.value)}
                                className="h-10 px-3 rounded-lg border border-slate-200 bg-white/50 backdrop-blur-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-slate-700 dark:bg-slate-800/50 text-sm"
                            >
                                <option value="all">すべて</option>
                                <option value="active">配信中</option>
                                <option value="completed">完了</option>
                                <option value="cancelled">停止中</option>
                            </select>

                            <select
                                value={scenarioFilter}
                                onChange={(e) => setScenarioFilter(e.target.value)}
                                className="h-10 px-3 rounded-lg border border-slate-200 bg-white/50 backdrop-blur-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-slate-700 dark:bg-slate-800/50 text-sm max-w-[200px]"
                            >
                                <option value="all">すべてのシナリオ</option>
                                {scenarios.map(s => (
                                    <option key={s.id} value={s.id}>{s.name}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                </CardHeader>
                <CardContent className="p-0">
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm text-left">
                            <thead className="bg-slate-50 dark:bg-slate-800/50 text-slate-500 dark:text-slate-400">
                                <tr>
                                    <th className="px-6 py-4 font-medium">ユーザー</th>
                                    <th className="px-6 py-4 font-medium">シナリオ名</th>
                                    <th className="px-6 py-4 font-medium">進捗</th>
                                    <th className="px-6 py-4 font-medium">状態</th>
                                    <th className="px-6 py-4 font-medium">次回配信予定</th>
                                    <th className="px-6 py-4 font-medium text-right">操作</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                                {loading && (
                                    <tr>
                                        <td colSpan={6} className="px-6 py-12 text-center">
                                            <Loader2 className="w-6 h-6 animate-spin mx-auto text-slate-400" />
                                        </td>
                                    </tr>
                                )}

                                {!loading && filteredExecutions.length === 0 && (
                                    <tr>
                                        <td colSpan={6} className="px-6 py-12 text-center text-slate-500">
                                            <ListChecks className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                                            該当する配信データがありません
                                        </td>
                                    </tr>
                                )}

                                {!loading && filteredExecutions.map((exec) => (
                                    <tr key={exec.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/50 transition-colors">
                                        <td className="px-6 py-4">
                                            <div className="flex items-center gap-3">
                                                <div className="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden flex-shrink-0">
                                                    {exec.line_users.picture_url ? (
                                                        <img src={exec.line_users.picture_url} alt="" className="w-full h-full object-cover" />
                                                    ) : (
                                                        <div className="w-full h-full flex items-center justify-center text-slate-400 text-xs">
                                                            ?
                                                        </div>
                                                    )}
                                                </div>
                                                <span className="font-medium truncate max-w-[140px]">{exec.line_users.display_name}</span>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <span className="text-slate-700 dark:text-slate-300 truncate max-w-[160px] inline-block">{exec.step_scenarios.name}</span>
                                        </td>
                                        <td className="px-6 py-4">
                                            <span className="font-semibold text-emerald-600">{exec.current_step}</span>
                                            <span className="text-slate-500 ml-1">通目</span>
                                            {exec.status === 'active' && <span className="text-slate-400 ml-0.5">待機中</span>}
                                        </td>
                                        <td className="px-6 py-4">
                                            <span className={cn(
                                                "inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border",
                                                getStatusColor(exec.status)
                                            )}>
                                                {getStatusIcon(exec.status)}
                                                {getStatusLabel(exec.status)}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 text-slate-600 dark:text-slate-400">
                                            {exec.status === 'active' ? formatDate(exec.next_send_at) : formatDate(exec.completed_at || exec.next_send_at)}
                                            {exec.status === 'active' && exec.next_send_at && new Date(exec.next_send_at) < new Date() && (
                                                <span className="text-red-500 text-xs flex items-center gap-1 mt-0.5">
                                                    <AlertCircle className="w-3 h-3" />遅延の可能性
                                                </span>
                                            )}
                                        </td>
                                        <td className="px-6 py-4 text-right">
                                            {exec.status === 'active' && (
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() => handleCancel(exec.id)}
                                                    className="text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20"
                                                >
                                                    停止
                                                </Button>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </CardContent>
            </Card>
        </div>
    )
}
