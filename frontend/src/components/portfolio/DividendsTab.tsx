import { useCallback, useEffect, useState } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EmptyTableRow } from '@/components/ui/empty-state'
import { getJson, postJson } from '../../lib/api'
import { formatMoney } from '../../lib/formatMoney'
import { MatchDividendModal } from './MatchDividendModal'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DividendRow = {
  id: number
  securityId: number
  symbol: string | null
  securityName: string | null
  exDividendDate: string
  paymentDate: string | null
  amount: string
  currency: string
  matchedTransactionId: number | null
  matchedAt: string | null
  matchedTransaction: {
    id: number
    date: string
    amount: string
    merchantClean: string
  } | null
  variancePct: number | null
}

type DividendsResponse = { dividends: DividendRow[] }

// ---------------------------------------------------------------------------
// DividendsTab
// ---------------------------------------------------------------------------

export function DividendsTab() {
  const [upcoming, setUpcoming] = useState<DividendRow[]>([])
  const [matched, setMatched] = useState<DividendRow[]>([])
  const [unmatched, setUnmatched] = useState<DividendRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [matchingDividend, setMatchingDividend] = useState<DividendRow | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const [upRes, matchedRes, unmatchedRes] = await Promise.all([
        getJson<DividendsResponse>('/api/dividends?status=upcoming'),
        getJson<DividendsResponse>('/api/dividends?status=matched&windowMonths=12'),
        getJson<DividendsResponse>('/api/dividends?status=unmatched&windowMonths=12'),
      ])
      setUpcoming(upRes.dividends)
      setMatched(matchedRes.dividends)
      setUnmatched(unmatchedRes.dividends)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load dividends')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function handleUnmatch(dividendId: number) {
    try {
      await postJson(`/api/dividends/${dividendId}/unmatch`)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to unmatch')
    }
  }

  return (
    <div className="space-y-6">
      {err && <p className="error">{err}</p>}

      {/* Upcoming dividends */}
      <Card className="transactionsTableCard">
        <div className="transactionsPanelHeader">
          <div>
            <h2>Upcoming dividends</h2>
            <p className="muted">Dividends with payment date in the next 30 days.</p>
          </div>
        </div>
        <div className="transactionsTableWrap">
          <Table className="table transactionsTable">
            <TableHeader>
              <TableRow>
                <TableHead>Symbol</TableHead>
                <TableHead>Ex-date</TableHead>
                <TableHead>Payment date</TableHead>
                <TableHead>Amount / share</TableHead>
                <TableHead>Currency</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {upcoming.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>{d.symbol ?? '—'}</TableCell>
                  <TableCell>{d.exDividendDate}</TableCell>
                  <TableCell>{d.paymentDate ?? '—'}</TableCell>
                  <TableCell>{formatMoney(Number(d.amount), d.currency)}</TableCell>
                  <TableCell>{d.currency}</TableCell>
                </TableRow>
              ))}
              {!loading && upcoming.length === 0 && (
                <EmptyTableRow
                  colSpan={5}
                  title="No upcoming dividends."
                  description="Dividends with a payment date in the next 30 days will appear here."
                />
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      {/* Matched dividends */}
      <Card className="transactionsTableCard">
        <div className="transactionsPanelHeader">
          <div>
            <h2>Matched (last 12 months)</h2>
            <p className="muted">Dividends linked to a transaction. Flag shown when variance &gt;5%.</p>
          </div>
        </div>
        <div className="transactionsTableWrap">
          <Table className="table transactionsTable">
            <TableHeader>
              <TableRow>
                <TableHead>Symbol</TableHead>
                <TableHead>Payment date</TableHead>
                <TableHead>Expected / share</TableHead>
                <TableHead>Matched transaction</TableHead>
                <TableHead>Actual amount</TableHead>
                <TableHead>Variance</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {matched.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>{d.symbol ?? '—'}</TableCell>
                  <TableCell>{d.paymentDate ?? '—'}</TableCell>
                  <TableCell>{formatMoney(Number(d.amount), d.currency)}</TableCell>
                  <TableCell>
                    {d.matchedTransaction
                      ? `${d.matchedTransaction.date} · ${d.matchedTransaction.merchantClean}`
                      : '—'}
                  </TableCell>
                  <TableCell>
                    {d.matchedTransaction
                      ? formatMoney(Number(d.matchedTransaction.amount), d.currency)
                      : '—'}
                  </TableCell>
                  <TableCell>
                    {d.variancePct != null ? (
                      <span
                        style={{
                          color:
                            Math.abs(d.variancePct) > 5
                              ? 'var(--accent-warm)'
                              : 'var(--muted-foreground)',
                          fontWeight: Math.abs(d.variancePct) > 5 ? 600 : 400,
                        }}
                      >
                        {d.variancePct > 0 ? '+' : ''}
                        {d.variancePct.toFixed(1)}%
                        {Math.abs(d.variancePct) > 5 && (
                          <span
                            style={{
                              marginLeft: 6,
                              padding: '1px 6px',
                              borderRadius: 4,
                              background: 'var(--accent-warm)',
                              color: '#fff',
                              fontSize: 11,
                            }}
                          >
                            Check
                          </span>
                        )}
                      </span>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      onClick={() => void handleUnmatch(d.id)}
                    >
                      Unmatch
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {!loading && matched.length === 0 && (
                <EmptyTableRow
                  colSpan={7}
                  title="No matched dividends yet."
                  description="Auto-matched dividends or manually linked dividends appear here."
                />
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      {/* Needs review */}
      <Card className="transactionsTableCard">
        <div className="transactionsPanelHeader">
          <div>
            <h2>Needs review</h2>
            <p className="muted">
              Past dividends (last 12 months) with no matched transaction. Click "Match…" to link
              one manually.
            </p>
          </div>
        </div>
        <div className="transactionsTableWrap">
          <Table className="table transactionsTable">
            <TableHeader>
              <TableRow>
                <TableHead>Symbol</TableHead>
                <TableHead>Ex-date</TableHead>
                <TableHead>Payment date</TableHead>
                <TableHead>Amount / share</TableHead>
                <TableHead>Currency</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {unmatched.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>{d.symbol ?? '—'}</TableCell>
                  <TableCell>{d.exDividendDate}</TableCell>
                  <TableCell>{d.paymentDate ?? '—'}</TableCell>
                  <TableCell>{formatMoney(Number(d.amount), d.currency)}</TableCell>
                  <TableCell>{d.currency}</TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      onClick={() => setMatchingDividend(d)}
                    >
                      Match…
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {!loading && unmatched.length === 0 && (
                <EmptyTableRow
                  colSpan={6}
                  title="No unmatched dividends."
                  description="All past dividends within the window have been reconciled."
                />
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      {matchingDividend && (
        <MatchDividendModal
          dividend={matchingDividend}
          onClose={() => setMatchingDividend(null)}
          onMatched={() => {
            setMatchingDividend(null)
            void load()
          }}
        />
      )}
    </div>
  )
}
