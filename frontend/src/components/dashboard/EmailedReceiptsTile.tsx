import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { BentoTile } from './BentoTile'
import { Button } from '@cashflow/ui'
import { getJson } from '@/lib/api'

type GmailStatus = {
  featureEnabled: boolean
  connected: boolean
  accountEmail?: string | null
}

type ReceiptOrder = { id: number }

export function EmailedReceiptsTile() {
  const [status, setStatus] = useState<GmailStatus | null>(null)
  const [gmailCount, setGmailCount] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const s = await getJson<GmailStatus>('/api/email/status')
        if (cancelled) return
        setStatus(s)
        if (s.featureEnabled && s.connected) {
          const orders = await getJson<ReceiptOrder[]>('/api/external-orders?group=gmail&limit=100')
          if (!cancelled) setGmailCount(orders.length)
        }
      } catch {
        if (!cancelled) setStatus({ featureEnabled: false, connected: false })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Don't nag when the integration isn't configured on the server, and render
  // nothing until status is known.
  if (!status || !status.featureEnabled) return null

  if (!status.connected) {
    return (
      <BentoTile span={6} rows={1} variant="warning" label="Emailed receipts">
        <div className="space-y-2">
          <p className="text-sm">
            Cashflow can auto-import receipts from your inbox (Apple, Amazon, Uber, and more) and match
            them to your card charges. It's set up but not connected.
          </p>
          <Button asChild size="sm"><Link to="/receipts">Connect Gmail</Link></Button>
        </div>
      </BentoTile>
    )
  }

  return (
    <BentoTile span={6} rows={1} label="Emailed receipts">
      <div className="space-y-2">
        <p className="text-sm">
          Connected{status.accountEmail ? ` as ${status.accountEmail}` : ''}.
          {gmailCount != null ? ` ${gmailCount} receipt${gmailCount === 1 ? '' : 's'} imported.` : ''}
        </p>
        <Button asChild size="sm" variant="outline"><Link to="/receipts">View receipts</Link></Button>
      </div>
    </BentoTile>
  )
}
