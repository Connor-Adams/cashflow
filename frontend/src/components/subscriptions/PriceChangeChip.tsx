import { TrendingUp } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { PendingPriceChange } from '../../types/api'
import { formatMoney } from '../../lib/formatMoney'

export function PriceChangeChip({
  change,
  onClick,
}: {
  change: PendingPriceChange
  onClick: () => void
}) {
  const pct = Math.abs(Number(change.pctChange) * 100).toFixed(1)
  const direction = Number(change.pctChange) > 0 ? 'up' : 'down'
  const prev = formatMoney(change.previousAmountCents / 100, change.currency)
  const next = formatMoney(change.newAmountCents / 100, change.currency)

  return (
    <button
      type="button"
      onClick={onClick}
      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
      title={`Price ${direction} ${pct}%: ${prev} → ${next}. Click to review.`}
    >
      <Badge variant="destructive" style={{ gap: 4 }}>
        <TrendingUp size={11} aria-hidden="true" />
        {direction === 'up' ? '+' : '-'}{pct}%
      </Badge>
    </button>
  )
}
