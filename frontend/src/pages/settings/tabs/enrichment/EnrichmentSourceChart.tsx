import { Card } from '@/components/ui/card'

const SOURCE_COLOR: Record<string, string> = {
  rules: 'var(--chart-2)',
  ai: 'var(--chart-3)',
  manual: 'var(--chart-5)',
  '(none)': 'var(--border)',
}

const LABEL: Record<string, string> = {
  '(none)': 'none',
}

type Props = {
  bySource: Record<string, number>
}

export function EnrichmentSourceChart({ bySource }: Props) {
  const entries = Object.entries(bySource).sort((a, b) => b[1] - a[1])
  const total = entries.reduce((acc, [, n]) => acc + n, 0)

  return (
    <Card className="enrichChartCard">
      <div className="enrichChartCard__header">
        <h3 className="enrichChartCard__title">By source</h3>
      </div>
      {entries.length === 0 ? (
        <p className="muted text-sm m-0">No source data yet. Run the backfill to populate.</p>
      ) : (
        <div className="enrichSourceList">
          {entries.map(([key, n]) => {
            const pct = total > 0 ? Math.round((n / total) * 100) : 0
            const color = SOURCE_COLOR[key] ?? 'var(--muted-foreground)'
            const label = LABEL[key] ?? key
            return (
              <div key={key} className="enrichSourceBar">
                <span className="enrichSourceBar__label">{label}</span>
                <div className="enrichSourceBar__track">
                  <div
                    className="enrichSourceBar__fill"
                    style={{ width: `${pct}%`, background: color }}
                  />
                </div>
                <span className="enrichSourceBar__count">{n.toLocaleString()} · {pct}%</span>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
