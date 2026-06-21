import { Card } from '@connor-adams/designsystem'

/**
 * Compact label/value summary card shared by the spend-overview pages
 * (MoneyLeaksPage, SubscriptionsPage). `tone="warn"` tints the value with the
 * warning token for amounts the user should notice (annual leak/spend impact).
 */
export function SummaryStat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'warn'
}) {
  return (
    <Card style={{ padding: 12 }}>
      <div className="muted" style={{ fontSize: 12 }}>
        {label}
      </div>
      <div
        className={tone === 'warn' ? 'text-warning' : undefined}
        style={{ fontSize: 20, fontWeight: 600 }}
      >
        {value}
      </div>
    </Card>
  )
}
