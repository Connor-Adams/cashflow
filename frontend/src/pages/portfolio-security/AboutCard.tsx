import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import type { PortfolioSecurityOverview } from '../../types/api'

const TRUNCATE_LEN = 240

export type AboutCardProps = {
  overview: PortfolioSecurityOverview | null
}

export function AboutCard({ overview }: AboutCardProps) {
  const [expanded, setExpanded] = useState(false)
  if (!overview) {
    return (
      <Card>
        <h2 className="text-base">About</h2>
        <p className="muted">No company info available.</p>
      </Card>
    )
  }
  const desc = overview.description ?? ''
  const truncated = desc.length > TRUNCATE_LEN && !expanded
  const shown = truncated ? desc.slice(0, TRUNCATE_LEN) + '…' : desc

  return (
    <Card>
      <div className="transactionsPanelHeader">
        <h2 className="text-base">About</h2>
      </div>
      <dl className="grid grid-cols-2 gap-2 text-sm">
        {overview.sector && (<><dt className="muted">Sector</dt><dd>{overview.sector}</dd></>)}
        {overview.industry && (<><dt className="muted">Industry</dt><dd>{overview.industry}</dd></>)}
        {overview.country && (<><dt className="muted">Country</dt><dd>{overview.country}</dd></>)}
        {overview.exchange && (<><dt className="muted">Exchange</dt><dd>{overview.exchange}</dd></>)}
      </dl>
      {desc && (
        <p className="mt-3 text-sm">
          {shown}{' '}
          {desc.length > TRUNCATE_LEN && (
            <Button
              type="button"
              variant="link"
              className="underline text-foreground"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? 'Show less' : 'Show more'}
            </Button>
          )}
        </p>
      )}
      {overview.metadataFetchedAt && (
        <p className="muted text-xs mt-3">
          Data from Yahoo Finance · refreshed {overview.metadataFetchedAt.slice(0, 10)}
        </p>
      )}
    </Card>
  )
}
