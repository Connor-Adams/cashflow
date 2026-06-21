import { Card } from '@connor-adams/designsystem'
import { formatMoney } from '../../lib/formatMoney'

export type ForwardIncomeStatsRowProps = {
  projectedAnnualIncomeCad: number
  forwardYieldPct: number
  forwardYieldOnCostPct: number
  computedAt: string
}

function fmtPct(x: number): string {
  return `${x.toFixed(2)}%`
}

export function ForwardIncomeStatsRow({
  projectedAnnualIncomeCad, forwardYieldPct, forwardYieldOnCostPct, computedAt,
}: ForwardIncomeStatsRowProps) {
  const dt = new Date(computedAt)
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Card>
        <p className="text-sm text-muted-foreground">Projected annual income (CAD)</p>
        <p className="text-2xl font-semibold">{formatMoney(projectedAnnualIncomeCad, 'CAD')}</p>
      </Card>
      <Card>
        <p className="text-sm text-muted-foreground">Forward yield</p>
        <p className="text-2xl font-semibold">{fmtPct(forwardYieldPct)}</p>
      </Card>
      <Card>
        <p className="text-sm text-muted-foreground">Forward yield on cost</p>
        <p className="text-2xl font-semibold">{fmtPct(forwardYieldOnCostPct)}</p>
      </Card>
      <Card>
        <p className="text-sm text-muted-foreground">Computed</p>
        <p className="text-sm">{dt.toLocaleString()}</p>
      </Card>
    </div>
  )
}
