import { Card } from '@/components/ui/card'
import { formatMoney } from '../../lib/formatMoney'
import type { PortfolioByAccountTypeHarvestCandidate } from '../../types/api'

export type HarvestCandidatesStripProps = {
  candidates: PortfolioByAccountTypeHarvestCandidate[]
}

export function HarvestCandidatesStrip({ candidates }: HarvestCandidatesStripProps) {
  if (candidates.length === 0) return null
  return (
    <Card className="my-3">
      <div className="transactionsPanelHeader">
        <h2 className="text-base">Tax-loss harvest candidates</h2>
        <p className="muted">
          Non-registered holdings with unrealized loss greater than $500 CAD.
        </p>
      </div>
      <ul className="text-sm" style={{ paddingLeft: 0, listStyle: 'none', margin: 0 }}>
        {candidates.map((c) => (
          <li key={`${c.securityId}-${c.accountId}`} className="mb-2">
            💰 <strong>{c.symbol}</strong> ({c.accountName}): unrealized loss{' '}
            {formatMoney(c.unrealizedLossCad, 'CAD')}
            {c.superficialLossWarning && (
              <div className="muted" style={{ color: 'var(--accent-warm)', marginLeft: '1.5em' }}>
                ⚠️ Superficial loss risk: {c.superficialLossDetail}
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}
