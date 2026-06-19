import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent } from '@cashflow/ui'
import { OpportunityCostCalculator } from '@/components/OpportunityCostCalculator'

/**
 * Opportunity Cost page (issue #252) — a standalone home for the calculator.
 *
 * The calculator answers "what if I invested this money instead of spending
 * it?" for one-time and recurring expenses. It performs no persistence, so
 * nothing here alters transactions or balances.
 */
export function OpportunityCostPage() {
  return (
    <div>
      <PageHeader
        title="Opportunity cost"
        description="See what a purchase could be worth if you invested the money instead. Adjust the return rate and horizon to match your own assumptions."
      />
      <Card>
        <CardContent className="pt-6">
          <OpportunityCostCalculator />
        </CardContent>
      </Card>
    </div>
  )
}
