import { Card } from '@/components/ui/card'

/**
 * Compact label/value summary card shared by the spend-overview pages
 * (MoneyLeaksPage, SubscriptionsPage). `tone="warn"` tints the value with the
 * warm accent for amounts the user should notice (annual leak/spend impact).
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
        style={{
          fontSize: 20,
          fontWeight: 600,
          color: tone === 'warn' ? 'var(--accent-warm)' : undefined,
        }}
      >
        {value}
      </div>
    </Card>
  )
}
