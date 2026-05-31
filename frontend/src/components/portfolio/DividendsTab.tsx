import { useCallback, useEffect, useState } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { getJson, postJson } from '../../lib/api'
import { formatMoney } from '../../lib/formatMoney'
import { useToast } from '@/components/ui/toast'
import { MatchDividendModal } from './MatchDividendModal'
import type { DividendRow, DividendsResponse } from '../../types/api'

type StatusKey = 'upcoming' | 'matched' | 'unmatched'

function StatusPill({ row }: { row: DividendRow }) {
  if (row.matchedTransactionId != null) {
    if (row.hasVarianceFlag) {
      return (
        <span
          className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-amber-100 text-amber-800"
          title={`Expected ${formatMoney(row.amount, row.currency)} · Actual ${row.matchedAmount != null ? formatMoney(row.matchedAmount, row.currency) : '—'} · Variance ${row.variancePct != null ? (row.variancePct * 100).toFixed(1) : '?'}%`}
        >
          Check
        </span>
      )
    }
    return (
      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-green-100 text-green-800">
        Matched
      </span>
    )
  }
  return (
    <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-red-100 text-red-800">
      Unmatched
    </span>
  )
}

function DividendList({
  rows,
  onMatch,
  onUnmatch,
}: {
  rows: DividendRow[]
  onMatch: (row: DividendRow) => void
  onUnmatch: (row: DividendRow) => void
}) {
  if (rows.length === 0) return <p className="muted px-4 py-3">None.</p>

  return (
    <div className="divide-y">
      {rows.map((row) => (
        <div key={row.id} className="flex items-center gap-3 px-4 py-3 text-sm">
          <div className="flex-1 min-w-0">
            <div className="font-medium truncate">
              {row.securitySymbol ?? `#${row.securityId}`}
              {row.securityName ? ` — ${row.securityName}` : ''}
            </div>
            <div className="text-muted-foreground text-xs">
              Ex-div {row.exDividendDate}
              {row.paymentDate ? ` · Pay ${row.paymentDate}` : ''}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div>{formatMoney(row.amount, row.currency)} / share</div>
            {row.matchedAmount != null && row.matchedAmount !== row.amount && (
              <div className="text-xs text-muted-foreground">
                Actual {formatMoney(row.matchedAmount, row.currency)}
              </div>
            )}
          </div>
          <StatusPill row={row} />
          {row.matchedTransactionId != null ? (
            <Button size="sm" variant="ghost" onClick={() => onUnmatch(row)}>Unmatch</Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => onMatch(row)}>Match…</Button>
          )}
        </div>
      ))}
    </div>
  )
}

export function DividendsTab() {
  const { showToast } = useToast()
  const [upcoming, setUpcoming] = useState<DividendRow[]>([])
  const [matched, setMatched] = useState<DividendRow[]>([])
  const [unmatched, setUnmatched] = useState<DividendRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [matchTarget, setMatchTarget] = useState<DividendRow | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const [up, ma, um] = await Promise.all([
        getJson<DividendsResponse>('/api/dividends?status=upcoming'),
        getJson<DividendsResponse>('/api/dividends?status=matched&windowMonths=12'),
        getJson<DividendsResponse>('/api/dividends?status=unmatched&windowMonths=12'),
      ])
      setUpcoming(up.dividends)
      setMatched(ma.dividends)
      setUnmatched(um.dividends)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load dividends')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const handleUnmatch = async (row: DividendRow) => {
    try {
      await postJson(`/api/dividends/${row.id}/unmatch`, {})
      showToast({ title: 'Unmatched.', variant: 'success' })
      void load()
    } catch {
      showToast({ title: "Couldn't update dividend match. Try again.", variant: 'error' })
    }
  }

  if (loading) return <p className="muted p-4">Loading…</p>
  if (err) return <p className="error p-4">{err}</p>

  const isEmpty = upcoming.length === 0 && matched.length === 0 && unmatched.length === 0

  if (isEmpty) {
    return (
      <Card>
        <p className="muted p-4">
          No dividends recorded yet. Activity sync detects ex-div and payment dates automatically.
        </p>
      </Card>
    )
  }

  return (
    <>
      <Card className="mb-4">
        <div className="px-4 py-3 border-b">
          <h3 className="font-semibold">Upcoming dividends</h3>
          <p className="muted text-xs">Payment dates in the future.</p>
        </div>
        <DividendList
          rows={upcoming}
          onMatch={(row) => setMatchTarget(row)}
          onUnmatch={(row) => void handleUnmatch(row)}
        />
      </Card>

      <Card className="mb-4">
        <div className="px-4 py-3 border-b">
          <h3 className="font-semibold">Matched (last 12 months)</h3>
          <p className="muted text-xs">Dividends confirmed against a transaction.</p>
        </div>
        <DividendList
          rows={matched}
          onMatch={(row) => setMatchTarget(row)}
          onUnmatch={(row) => void handleUnmatch(row)}
        />
      </Card>

      <Card>
        <div className="px-4 py-3 border-b">
          <h3 className="font-semibold">Needs review</h3>
          <p className="muted text-xs">Past dividends without a matched transaction.</p>
        </div>
        <DividendList
          rows={unmatched}
          onMatch={(row) => setMatchTarget(row)}
          onUnmatch={(row) => void handleUnmatch(row)}
        />
      </Card>

      {matchTarget && (
        <MatchDividendModal
          dividend={matchTarget}
          onClose={() => setMatchTarget(null)}
          onMatched={() => { setMatchTarget(null); void load() }}
        />
      )}
    </>
  )
}
