import { useState } from 'react'
import { Button } from '@cashflow/ui'
import { Card } from '@cashflow/ui'

export type CaveatsBannerProps = {
  unreliableSymbols: string[]
  holdingsWithoutHistory: Array<{
    symbol: string
    reason: 'no_dividend_history' | 'insufficient_history'
  }>
}

export function CaveatsBanner({ unreliableSymbols, holdingsWithoutHistory }: CaveatsBannerProps) {
  const [expanded, setExpanded] = useState(false)
  if (unreliableSymbols.length === 0 && holdingsWithoutHistory.length === 0) return null
  const total = unreliableSymbols.length + holdingsWithoutHistory.length
  return (
    <Card className="my-3" style={{ borderLeft: '3px solid var(--accent-warm)' }}>
      <div className="flex items-center justify-between">
        <span className="text-sm">
          {total} holdings have unreliable or missing income projections.
        </span>
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Hide details' : 'Show details'}
        </Button>
      </div>
      {expanded && (
        <div className="mt-3 text-sm">
          {unreliableSymbols.length > 0 && (
            <div className="mb-2">
              <p className="font-medium mb-1">Unreliable cadence (CV &gt; 25%):</p>
              <ul className="list-disc pl-6">
                {unreliableSymbols.map((s) => <li key={s}>{s}</li>)}
              </ul>
            </div>
          )}
          {holdingsWithoutHistory.length > 0 && (
            <div>
              <p className="font-medium mb-1">Holdings without history:</p>
              <ul className="list-disc pl-6">
                {holdingsWithoutHistory.map((h) => (
                  <li key={h.symbol}>
                    {h.symbol} — {h.reason === 'no_dividend_history' ? 'no dividend history' : 'insufficient history'}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}
