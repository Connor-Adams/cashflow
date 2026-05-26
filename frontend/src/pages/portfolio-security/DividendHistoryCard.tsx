import { useEffect, useState } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Card } from '@/components/ui/card'
import { getJson } from '../../lib/api'
import { getAppConfig } from '../../lib/appConfig'
import { formatMoney } from '../../lib/formatMoney'
import type { PortfolioSecurityDividends } from '../../types/api'

export type DividendHistoryCardProps = {
  securityId: number
  currency: string
}

export function DividendHistoryCard({ securityId, currency }: DividendHistoryCardProps) {
  const quoteProviderConfigured =
    getAppConfig()?.quoteProviderConfigured ?? false
  const [data, setData] = useState<PortfolioSecurityDividends | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!quoteProviderConfigured) return
    let cancelled = false
    void getJson<PortfolioSecurityDividends>(`/api/portfolio/security/${securityId}/dividends`)
      .then((res) => { if (!cancelled) setData(res) })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : 'Failed to load dividends') })
    return () => { cancelled = true }
  }, [securityId, quoteProviderConfigured])

  if (!quoteProviderConfigured) {
    return (
      <Card>
        <div className="transactionsPanelHeader">
          <div>
            <h2 className="text-base">Dividend history</h2>
          </div>
        </div>
        <p className="muted">Quote provider is not configured.</p>
      </Card>
    )
  }

  return (
    <Card>
      <div className="transactionsPanelHeader">
        <div>
          <h2 className="text-base">Dividend history</h2>
          <p className="muted">One bar per ex-dividend event. Hover for amount + record/payment dates.</p>
        </div>
      </div>
      {err && <p className="error">{err}</p>}
      {!data ? (
        <p className="muted">Loading…</p>
      ) : data.events.length === 0 ? (
        <p className="muted">No dividends recorded for this security.</p>
      ) : (
        <div style={{ width: '100%', height: 260 }}>
          <ResponsiveContainer>
            <BarChart data={data.events.map((e) => ({
              date: e.exDividendDate,
              amount: e.amount,
              payment: e.paymentDate ?? '—',
              record: e.recordDate ?? '—',
            }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip
                formatter={(value, _name, ctx) => {
                  const v = typeof value === 'number' ? value : Number(value)
                  if (!Number.isFinite(v)) return ''
                  const row = ctx?.payload as { payment?: string; record?: string }
                  return [
                    `${formatMoney(v, currency)} · pay ${row?.payment ?? '—'} · rec ${row?.record ?? '—'}`,
                    'Amount',
                  ]
                }}
              />
              <Bar dataKey="amount" fill="var(--chart-line-2)" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  )
}
