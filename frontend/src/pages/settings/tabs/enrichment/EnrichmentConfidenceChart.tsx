import { Link } from 'react-router-dom'
import { Card } from '@connor-adams/designsystem'
import { enrichmentFilterHref } from './enrichmentFilterHref'

type Band = {
  key: 'high' | 'medium' | 'low' | '(none)'
  label: string
  cssVar: string
}

// Dynamic indexed swatch colors consumed as style.background — keep inline var().
const BANDS: Band[] = [
  { key: 'high',   label: 'High', cssVar: 'var(--success)' },
  { key: 'medium', label: 'Med',  cssVar: 'var(--primary)' },
  { key: 'low',    label: 'Low',  cssVar: 'var(--warning)' },
  { key: '(none)', label: 'None', cssVar: 'var(--muted-foreground)' },
]

type Props = {
  byConfidence: Record<string, number>
}

export function EnrichmentConfidenceChart({ byConfidence }: Props) {
  const counts = BANDS.map((b) => ({ ...b, n: byConfidence[b.key] ?? 0 }))
  const total = counts.reduce((acc, c) => acc + c.n, 0)

  return (
    <Card>
      <div className="flex justify-between items-baseline mb-3">
        <h3 className="text-[0.95rem] font-semibold m-0">Confidence distribution</h3>
        <span className="bg-[color-mix(in_srgb,var(--primary)_24%,transparent)] text-primary-foreground px-[10px] py-[2px] rounded-full text-[0.7rem] font-semibold tracking-[0.04em] whitespace-nowrap">{total.toLocaleString()} rows</span>
      </div>
      <div
        className="flex h-[22px] rounded-[4px] overflow-hidden mb-[0.625rem] bg-muted"
        role="img"
        aria-label={`Confidence distribution: ${counts.map((c) => `${c.label} ${c.n}`).join(', ')}`}
      >
        {counts.map((c) => (
          <div
            key={c.key}
            className="h-full min-w-0"
            style={{ flex: c.n > 0 ? c.n : 0, background: c.cssVar }}
            title={`${c.label}: ${c.n.toLocaleString()}`}
          />
        ))}
      </div>
      <div className="flex gap-[0.875rem] flex-wrap text-[0.74rem] text-muted-foreground">
        {counts.map((c) => (
          <Link
            key={c.key}
            to={enrichmentFilterHref('autoConfidence', c.key)}
            className="inline-flex items-center gap-[0.35rem] no-underline hover:opacity-80"
            aria-label={`View ${c.label} confidence transactions`}
          >
            <span className="inline-block w-[10px] h-[10px] rounded-[2px]" style={{ background: c.cssVar }} />
            <span className="text-foreground font-medium">{c.label}</span>{' '}
            <span className="tabular-nums">{c.n.toLocaleString()}</span>
          </Link>
        ))}
      </div>
    </Card>
  )
}
