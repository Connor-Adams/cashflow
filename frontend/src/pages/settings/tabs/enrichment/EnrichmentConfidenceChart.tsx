import { Card } from '@/components/ui/card'

type Band = {
  key: 'high' | 'medium' | 'low' | '(none)'
  label: string
  cssVar: string
}

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
    <Card className="enrichChartCard">
      <div className="enrichChartCard__header">
        <h3 className="enrichChartCard__title">Confidence distribution</h3>
        <span className="enrichAdminPill enrichAdminPill--amber">{total.toLocaleString()} rows</span>
      </div>
      <div className="enrichConfidenceBar" role="img" aria-label={`Confidence distribution: ${counts.map((c) => `${c.label} ${c.n}`).join(', ')}`}>
        {counts.map((c) => (
          <div
            key={c.key}
            className="enrichConfidenceBar__seg"
            style={{ flex: c.n > 0 ? c.n : 0, background: c.cssVar }}
            title={`${c.label}: ${c.n.toLocaleString()}`}
          />
        ))}
      </div>
      <div className="enrichConfidenceLegend">
        {counts.map((c) => (
          <span key={c.key} className="enrichConfidenceLegend__item">
            <span className="enrichConfidenceLegend__swatch" style={{ background: c.cssVar }} />
            <span className="enrichConfidenceLegend__label">{c.label}</span>{' '}
            <span className="enrichConfidenceLegend__count">{c.n.toLocaleString()}</span>
          </span>
        ))}
      </div>
    </Card>
  )
}
