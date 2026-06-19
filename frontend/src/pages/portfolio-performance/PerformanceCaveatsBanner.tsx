import { useState } from 'react'
import { Button } from '@cashflow/ui'
import { Card } from '@cashflow/ui'

export type PerformanceCaveatsBannerProps = {
  partialDaysCount: number
  missingDataReasons: string[]
  benchmarkSymbol: string
  benchmarkIsPartial: boolean
}

export function PerformanceCaveatsBanner({
  partialDaysCount, missingDataReasons, benchmarkSymbol, benchmarkIsPartial,
}: PerformanceCaveatsBannerProps) {
  const [expanded, setExpanded] = useState(false)
  if (partialDaysCount === 0 && !benchmarkIsPartial) return null
  return (
    <Card className="my-3" style={{ borderLeft: '3px solid var(--accent-warm)' }}>
      <div className="flex items-center justify-between">
        <div className="text-sm">
          {partialDaysCount > 0 && <span>{partialDaysCount} days have incomplete data.</span>}
          {benchmarkIsPartial && <span className="ml-2">Benchmark data incomplete for {benchmarkSymbol}.</span>}
        </div>
        {missingDataReasons.length > 0 && (
          <Button type="button" variant="link" size="sm" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Hide details' : 'Show details'}
          </Button>
        )}
      </div>
      {expanded && missingDataReasons.length > 0 && (
        <ul className="mt-2 list-disc pl-6 text-sm">
          {missingDataReasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
      )}
    </Card>
  )
}
