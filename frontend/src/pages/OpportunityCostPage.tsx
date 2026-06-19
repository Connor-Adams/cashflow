import { useState } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@cashflow/ui'
import { Card, CardContent } from '@cashflow/ui'
import { EmptyState } from '@cashflow/ui'
import { OpportunityCostCalculator } from '@/components/OpportunityCostCalculator'

/**
 * Opportunity Cost page (issue #252) — a standalone home for the calculator.
 *
 * The calculator answers "what if I invested this money instead of spending
 * it?" for one-time and recurring expenses. It performs no persistence, so
 * nothing here alters transactions or balances.
 *
 * Before the user has entered a scenario we surface an EmptyState (issue
 * #799) explaining what the page does, with a "Try an example" CTA that
 * prefills the calculator with a sample amount.
 */

/** Sample purchase amount used by the "Try an example" CTA. */
const EXAMPLE_AMOUNT = 200

export function OpportunityCostPage() {
  // `null` until the user opts into an example; once set we hide the empty
  // state and remount the calculator with the example amount prefilled.
  const [exampleAmount, setExampleAmount] = useState<number | null>(null)
  const started = exampleAmount !== null

  return (
    <div>
      <PageHeader
        title="Opportunity cost"
        description="See what a purchase could be worth if you invested the money instead. Adjust the return rate and horizon to match your own assumptions."
      />
      {!started && (
        <EmptyState
          className="mb-4"
          title="See what a purchase could cost you"
          description="Enter a price to find out what that money could grow to if you invested it instead."
          actions={
            <Button size="sm" onClick={() => setExampleAmount(EXAMPLE_AMOUNT)}>
              Try an example
            </Button>
          }
        />
      )}
      <Card>
        <CardContent className="pt-6">
          <OpportunityCostCalculator
            key={started ? 'example' : 'blank'}
            initialAmount={exampleAmount ?? 0}
          />
        </CardContent>
      </Card>
    </div>
  )
}
