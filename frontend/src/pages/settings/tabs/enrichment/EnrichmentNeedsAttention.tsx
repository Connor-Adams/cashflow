// EnrichmentNeedsAttention.tsx
import { Link } from 'react-router-dom'
import { Card } from '@connor-adams/designsystem'
import type { EnrichmentStats } from '../../../../types/api'

type Props = { stats: EnrichmentStats }

type Tile = { label: string; count: number; href: string }

export function EnrichmentNeedsAttention({ stats }: Props) {
  const tiles: Tile[] = [
    { label: 'Needs review', count: stats.reviewFlagTrue, href: '/transactions?reviewFlag=true' },
    { label: 'Uncategorized', count: stats.uncategorizedCount, href: '/transactions?category=%28none%29' },
    { label: 'Missing canonical', count: stats.merchantsMissingCanonical, href: '/transactions?merchantCanonical=%28none%29' },
    { label: 'Dead rules', count: stats.deadRules.length, href: '/rules' },
  ]
  return (
    <div className="grid gap-[0.625rem] [grid-template-columns:repeat(4,1fr)] max-[760px]:grid-cols-2 max-[420px]:grid-cols-1">
      {tiles.map((t) => {
        const body = (
          <>
            <p className="text-[0.72rem] font-semibold uppercase tracking-normal text-muted-foreground m-0">{t.label}</p>
            <p className="m-0 text-[1.55rem] font-bold tabular-nums">{t.count.toLocaleString()}</p>
          </>
        )
        return t.count > 0 ? (
          <Link key={t.label} to={t.href} aria-label={t.label}
            className="no-underline hover:opacity-80">
            <Card className="mb-0 border-[color-mix(in_srgb,var(--warning)_40%,var(--border))]">{body}</Card>
          </Link>
        ) : (
          <Card key={t.label} className="mb-0 opacity-60">{body}</Card>
        )
      })}
    </div>
  )
}
