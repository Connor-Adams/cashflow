import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { postJson } from '../../lib/api'
import { formatMoney } from '../../lib/formatMoney'
import type { PendingPriceChange } from '../../types/api'

export function PriceChangeDrawer({
  subscriptionName,
  change,
  open,
  onOpenChange,
  onAcknowledged,
}: {
  subscriptionName: string
  change: PendingPriceChange
  open: boolean
  onOpenChange: (open: boolean) => void
  onAcknowledged: (changeId: number) => void
}) {
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const pct = Number(change.pctChange) * 100
  const direction = pct > 0 ? 'increase' : 'decrease'
  const prev = formatMoney(change.previousAmountCents / 100, change.currency)
  const next = formatMoney(change.newAmountCents / 100, change.currency)
  const absPct = Math.abs(pct).toFixed(1)

  async function acknowledge() {
    setLoading(true)
    setErr(null)
    try {
      await postJson(`/api/subscription-price-changes/${change.id}/acknowledge`, {})
      onAcknowledged(change.id)
      onOpenChange(false)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to acknowledge')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogHeader>
        <DialogTitle>Price {direction} detected</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p style={{ marginBottom: 12 }}>
          <strong>{subscriptionName}</strong> has a price {direction} of{' '}
          <strong>{absPct}%</strong> detected on {change.detectedOn}.
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <tbody>
            <tr>
              <td style={{ padding: '6px 0', color: 'var(--muted-foreground)' }}>Previous</td>
              <td style={{ padding: '6px 0', textAlign: 'right' }}>{prev}</td>
            </tr>
            <tr>
              <td style={{ padding: '6px 0', color: 'var(--muted-foreground)' }}>New</td>
              <td style={{ padding: '6px 0', textAlign: 'right', fontWeight: 600 }}>{next}</td>
            </tr>
            <tr>
              <td style={{ padding: '6px 0', color: 'var(--muted-foreground)' }}>Change</td>
              <td
                style={{
                  padding: '6px 0',
                  textAlign: 'right',
                  color: pct > 0 ? 'var(--destructive)' : 'var(--success, #16a34a)',
                }}
              >
                {pct > 0 ? '+' : ''}{absPct}%
              </td>
            </tr>
          </tbody>
        </table>
        {err && (
          <p className="error" role="alert" style={{ marginTop: 8 }}>
            {err}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenChange(false)}
          disabled={loading}
        >
          Dismiss
        </Button>
        <Button
          type="button"
          onClick={() => void acknowledge()}
          disabled={loading}
        >
          {loading ? 'Acknowledging…' : 'Acknowledge'}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
