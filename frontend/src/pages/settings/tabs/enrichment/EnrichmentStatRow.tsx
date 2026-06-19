import { Link } from 'react-router-dom'
import { Card } from '@cashflow/ui'
import { StatCard } from '@/components/ui/stat-card'
import type { EnrichmentStats } from '../../../../types/api'

type Props = {
  stats: EnrichmentStats
}

export function EnrichmentStatRow({ stats }: Props) {
  const totalPct = stats.total > 0 ? Math.round((stats.reviewFlagTrue / stats.total) * 100) : 0

  const cleared = stats.reviewFlagFalse.toLocaleString()
  const total = stats.total.toLocaleString()

  return (
    <div className="grid gap-[0.625rem] mb-[0.875rem] [grid-template-columns:1.6fr_repeat(5,1fr)] max-[960px]:[grid-template-columns:repeat(2,1fr)] max-[520px]:grid-cols-1">
      {stats.reviewFlagTrue > 0 ? (
        <Card
          className="enrichWorkflowTile flex flex-col justify-between gap-2 bg-[var(--warning-bg)] border-[color-mix(in_srgb,var(--warning)_40%,var(--border))] text-[var(--warning-foreground)]"
        >
          <p className="statLabel m-0 text-[0.7rem] uppercase tracking-[0.06em] text-[var(--warning-foreground)] opacity-85">Needs review</p>
          <p className="statValue m-0 mt-[0.125rem] text-[1.7rem] font-bold leading-[1.1] text-[var(--warning-foreground)] tabular-nums">
            {stats.reviewFlagTrue.toLocaleString()}{' '}
            <span className="text-[0.8rem] font-medium opacity-75">{totalPct}%</span>
          </p>
          <p className="mt-[0.25rem] text-[0.78rem] text-[var(--warning-foreground)] opacity-85">{(stats.byConfidence['low'] ?? 0).toLocaleString()} low-confidence overall</p>
          <Link
            to="/review"
            className="mt-auto self-start inline-block py-[7px] px-[14px] text-[0.8rem] font-semibold rounded-[6px] bg-[var(--primary)] text-[var(--primary-foreground)] border border-[var(--primary-hover)] no-underline hover:bg-[var(--primary-hover)]"
          >
            Open review queue →
          </Link>
        </Card>
      ) : (
        <StatCard className="enrichWorkflowTile enrichWorkflowTile--empty" label="In review" value="0" />
      )}
      <StatCard label="Total" value={total} />
      <StatCard label="Cleared" value={<span className="text-[var(--success)]">{cleared}</span>} />
      <StatCard label="Recurring" value={stats.isRecurringCount.toLocaleString()} />
      <StatCard label="Refunds linked" value={stats.refundLinkedCount.toLocaleString()} />
      <StatCard label="Transfers linked" value={stats.transferLinkedCount.toLocaleString()} />
    </div>
  )
}
