import { useCallback, useEffect, useState } from 'react'
import { CheckCircle, Clock, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyTableRow } from '@/components/ui/empty-state'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { getJson, postJson } from '@/lib/api'
import { formatMoney } from '@/lib/formatMoney'
import { MatchDividendModal } from './MatchDividendModal'

type Dividend = {
  id: number
  securityId: number
  exDividendDate: string
  paymentDate: string | null
  amount: string
  currency: string
  matchedTransactionId: number | null
  matchedAt: string | null
  security?: { id: number; symbol: string }
}

type Section = 'upcoming' | 'unmatched' | 'matched'

function useDividends(status: Section) {
  const [items, setItems] = useState<Dividend[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    getJson<Dividend[]>(`/api/dividends?status=${status}&windowMonths=12`)
      .then(setItems)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [status])

  useEffect(() => {
    load()
  }, [load])

  return { items, loading, error, reload: load }
}

export function DividendsTab() {
  const upcoming = useDividends('upcoming')
  const unmatched = useDividends('unmatched')
  const matched = useDividends('matched')

  const [matchTarget, setMatchTarget] = useState<Dividend | null>(null)

  function handleMatchDone() {
    setMatchTarget(null)
    unmatched.reload()
    matched.reload()
  }

  async function handleUnmatch(div: Dividend) {
    try {
      await postJson(`/api/dividends/${div.id}/unmatch`, {})
      unmatched.reload()
      matched.reload()
    } catch {
      // silent; user can retry
    }
  }

  return (
    <>
      {matchTarget && (
        <MatchDividendModal
          dividend={matchTarget}
          onDone={handleMatchDone}
          onCancel={() => setMatchTarget(null)}
        />
      )}

      <UpcomingSection {...upcoming} />

      <NeedsReviewSection
        {...unmatched}
        onMatch={setMatchTarget}
      />

      <MatchedSection
        {...matched}
        onUnmatch={(div) => void handleUnmatch(div)}
      />
    </>
  )
}

function UpcomingSection({
  items,
  loading,
  error,
}: {
  items: Dividend[]
  loading: boolean
  error: string | null
}) {
  return (
    <Card className="transactionsTableCard">
      <div className="transactionsPanelHeader">
        <div>
          <h2 className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-blue-500" />
            Upcoming (next 30 days)
          </h2>
          <p className="muted">Dividends with a payment date in the next 30 days.</p>
        </div>
      </div>
      {error && <p className="error px-4">{error}</p>}
      <div className="transactionsTableWrap">
        <Table className="table transactionsTable">
          <TableHeader>
            <TableRow>
              <TableHead>Symbol</TableHead>
              <TableHead>Ex-div date</TableHead>
              <TableHead>Payment date</TableHead>
              <TableHead>Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((d) => (
              <TableRow key={d.id}>
                <TableCell>{d.security?.symbol ?? `#${d.securityId}`}</TableCell>
                <TableCell>{d.exDividendDate}</TableCell>
                <TableCell>{d.paymentDate ?? '—'}</TableCell>
                <TableCell>{formatMoney(Number(d.amount), d.currency)}</TableCell>
              </TableRow>
            ))}
            {!loading && items.length === 0 && (
              <EmptyTableRow
                colSpan={4}
                title="No upcoming dividends"
                description="Dividends scheduled in the next 30 days appear here."
              />
            )}
          </TableBody>
        </Table>
      </div>
    </Card>
  )
}

function NeedsReviewSection({
  items,
  loading,
  error,
  onMatch,
}: {
  items: Dividend[]
  loading: boolean
  error: string | null
  onMatch: (div: Dividend) => void
}) {
  return (
    <Card className="transactionsTableCard mt-4">
      <div className="transactionsPanelHeader">
        <div>
          <h2 className="flex items-center gap-2">
            <XCircle className="h-4 w-4 text-destructive" />
            Needs review
          </h2>
          <p className="muted">Past dividends (last 12 months) with no matched transaction.</p>
        </div>
      </div>
      {error && <p className="error px-4">{error}</p>}
      <div className="transactionsTableWrap">
        <Table className="table transactionsTable">
          <TableHeader>
            <TableRow>
              <TableHead>Symbol</TableHead>
              <TableHead>Ex-div date</TableHead>
              <TableHead>Payment date</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((d) => (
              <TableRow key={d.id}>
                <TableCell>{d.security?.symbol ?? `#${d.securityId}`}</TableCell>
                <TableCell>{d.exDividendDate}</TableCell>
                <TableCell>{d.paymentDate ?? '—'}</TableCell>
                <TableCell>{formatMoney(Number(d.amount), d.currency)}</TableCell>
                <TableCell>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => onMatch(d)}
                  >
                    Match
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {!loading && items.length === 0 && (
              <EmptyTableRow
                colSpan={5}
                title="All dividends matched"
                description="No unmatched dividend payouts in the last 12 months."
              />
            )}
          </TableBody>
        </Table>
      </div>
    </Card>
  )
}

function MatchedSection({
  items,
  loading,
  error,
  onUnmatch,
}: {
  items: Dividend[]
  loading: boolean
  error: string | null
  onUnmatch: (div: Dividend) => void
}) {
  return (
    <Card className="transactionsTableCard mt-4">
      <div className="transactionsPanelHeader">
        <div>
          <h2 className="flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-green-500" />
            Matched (last 12 months)
          </h2>
          <p className="muted">Dividend payouts linked to a transaction.</p>
        </div>
      </div>
      {error && <p className="error px-4">{error}</p>}
      <div className="transactionsTableWrap">
        <Table className="table transactionsTable">
          <TableHeader>
            <TableRow>
              <TableHead>Symbol</TableHead>
              <TableHead>Ex-div date</TableHead>
              <TableHead>Payment date</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Matched at</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((d) => (
              <TableRow key={d.id}>
                <TableCell>{d.security?.symbol ?? `#${d.securityId}`}</TableCell>
                <TableCell>{d.exDividendDate}</TableCell>
                <TableCell>{d.paymentDate ?? '—'}</TableCell>
                <TableCell>{formatMoney(Number(d.amount), d.currency)}</TableCell>
                <TableCell>
                  {d.matchedAt ? new Date(d.matchedAt).toLocaleDateString() : '—'}
                </TableCell>
                <TableCell>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => onUnmatch(d)}
                  >
                    Unmatch
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {!loading && items.length === 0 && (
              <EmptyTableRow
                colSpan={6}
                title="No matched dividends yet"
                description="Matched dividends appear here once the auto-reconciliation job runs or you match manually."
              />
            )}
          </TableBody>
        </Table>
      </div>
    </Card>
  )
}
