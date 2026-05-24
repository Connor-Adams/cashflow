import { Link } from 'react-router-dom'
import { Card } from '@/components/ui/card'
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
    <div className="enrichStatGrid">
      {stats.reviewFlagTrue > 0 ? (
        <Card className="enrichWorkflowTile">
          <p className="statLabel enrichWorkflowTile__label">Needs review</p>
          <p className="statValue enrichWorkflowTile__value">
            {stats.reviewFlagTrue.toLocaleString()}{' '}
            <span className="enrichWorkflowTile__pct">{totalPct}%</span>
          </p>
          <p className="enrichWorkflowTile__sub">{(stats.byConfidence['low'] ?? 0).toLocaleString()} low-confidence overall</p>
          <Link to="/review" className="enrichWorkflowTile__cta">
            Open review queue →
          </Link>
        </Card>
      ) : (
        <StatCard className="enrichWorkflowTile enrichWorkflowTile--empty" label="In review" value="0" />
      )}
      <StatCard label="Total" value={total} />
      <StatCard label="Cleared" value={cleared} className="enrichStatCleared" />
      <StatCard label="Recurring" value={stats.isRecurringCount.toLocaleString()} />
      <StatCard label="Refunds linked" value={stats.refundLinkedCount.toLocaleString()} />
      <StatCard label="Transfers linked" value={stats.transferLinkedCount.toLocaleString()} />
    </div>
  )
}
