import { useCallback, useEffect, useState } from 'react'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import { getJson, postJson } from '../../lib/api'
import type {
  DividendCandidate,
  DividendListResponse,
  DividendReconciliationRow,
  DividendUpcomingRow,
} from '../../types/api'
import { MatchDividendModal } from './MatchDividendModal'

function formatMoney(amount: number | null, currency: string | null): string {
  if (amount == null) return '—'
  const body = Math.abs(amount).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `$${body}${currency ? ` ${currency}` : ''}`
}

function VarianceCheckPill({ row }: { row: DividendReconciliationRow }) {
  if (!row.varianceFlag) return null
  const variance = row.variancePct != null ? `${row.variancePct.toFixed(1)}%` : '—'
  const tip = `Expected ${formatMoney(row.expectedAmount, row.currency)} · Actual ${formatMoney(
    row.actualAmount,
    row.currency,
  )} · Variance ${variance}`
  return (
    <Badge variant="secondary" title={tip} data-testid="dividend-variance-pill">
      Check
    </Badge>
  )
}

export function DividendsTab() {
  const { showToast } = useToast()
  const [upcoming, setUpcoming] = useState<DividendUpcomingRow[]>([])
  const [matched, setMatched] = useState<DividendReconciliationRow[]>([])
  const [unmatched, setUnmatched] = useState<DividendReconciliationRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [matchTarget, setMatchTarget] = useState<DividendReconciliationRow | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const [up, mt, un] = await Promise.all([
        getJson<DividendListResponse>('/api/dividends?status=upcoming'),
        getJson<DividendListResponse>('/api/dividends?status=matched&windowMonths=12'),
        getJson<DividendListResponse>('/api/dividends?status=unmatched&windowMonths=12'),
      ])
      setUpcoming(up.data as DividendUpcomingRow[])
      setMatched(mt.data as DividendReconciliationRow[])
      setUnmatched(un.data as DividendReconciliationRow[])
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load dividends')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const onMatched = useCallback(
    (_row: DividendReconciliationRow, candidate: DividendCandidate) => {
      showToast({
        variant: 'success',
        title: `Matched to ${candidate.merchant ?? 'transaction'}, ${formatMoney(
          candidate.amount,
          candidate.currency,
        )}.`,
      })
      void load()
    },
    [showToast, load],
  )

  const onUnmatch = useCallback(
    async (row: DividendReconciliationRow) => {
      try {
        await postJson(`/api/dividends/${row.reconciliationId}/unmatch`, {})
        showToast({ variant: 'default', title: 'Dividend unmatched.' })
        void load()
      } catch (e) {
        showToast({
          variant: 'destructive',
          title: "Couldn't update dividend match. Try again.",
          description: e instanceof Error ? e.message : undefined,
        })
      }
    },
    [showToast, load],
  )

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Dividends</CardTitle>
        </CardHeader>
        <div className="flex flex-col gap-2 p-4">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
        </div>
      </Card>
    )
  }

  if (err) {
    return <p className="text-sm text-destructive">{err}</p>
  }

  const isEmpty = upcoming.length === 0 && matched.length === 0 && unmatched.length === 0
  if (isEmpty) {
    return (
      <Card>
        <p className="p-4 text-sm text-muted-foreground">
          No dividends recorded yet. Activity sync detects ex-div and payment dates automatically.
        </p>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <MatchDividendModal
        reconciliation={matchTarget}
        onOpenChange={(open) => {
          if (!open) setMatchTarget(null)
        }}
        onMatched={onMatched}
        onError={(message) => showToast({ variant: 'destructive', title: message })}
      />

      {/* Needs review (unmatched) */}
      <section data-testid="dividends-section-unmatched">
        <Card>
          <CardHeader>
            <CardTitle>Needs review</CardTitle>
          </CardHeader>
          <div className="p-4">
            {unmatched.length === 0 ? (
              <p className="text-sm text-muted-foreground">No unmatched dividends. Nice.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {unmatched.map((row) => (
                  <li
                    key={row.reconciliationId}
                    className="flex items-center justify-between gap-3 py-2 text-sm"
                  >
                    <span className="flex items-center gap-2">
                      <Badge variant="destructive">Unmatched</Badge>
                      <span className="font-medium">{row.symbol ?? '—'}</span>
                      <span className="text-xs text-muted-foreground">
                        {row.paymentDate} · {row.accountName ?? 'account'}
                      </span>
                    </span>
                    <span className="flex items-center gap-3">
                      <span>{formatMoney(row.expectedAmount, row.currency)}</span>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setMatchTarget(row)}
                      >
                        Match…
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </section>

      {/* Matched (last 12 months) */}
      <section data-testid="dividends-section-matched">
        <Card>
          <CardHeader>
            <CardTitle>Matched (last 12 months)</CardTitle>
          </CardHeader>
          <div className="p-4">
            {matched.length === 0 ? (
              <p className="text-sm text-muted-foreground">No matched dividends yet.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {matched.map((row) => (
                  <li
                    key={row.reconciliationId}
                    className="flex items-center justify-between gap-3 py-2 text-sm"
                  >
                    <span className="flex items-center gap-2">
                      <Badge variant={row.varianceFlag ? 'secondary' : 'default'}>Matched</Badge>
                      <span className="font-medium">{row.symbol ?? '—'}</span>
                      <span className="text-xs text-muted-foreground">
                        {row.paymentDate} · {row.accountName ?? 'account'}
                      </span>
                      <VarianceCheckPill row={row} />
                    </span>
                    <span className="flex items-center gap-3">
                      <span>{formatMoney(row.actualAmount, row.currency)}</span>
                      <Button type="button" variant="ghost" onClick={() => onUnmatch(row)}>
                        Unmatch
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </section>

      {/* Upcoming (next 30 days) */}
      <section data-testid="dividends-section-upcoming">
        <Card>
          <CardHeader>
            <CardTitle>Upcoming dividends</CardTitle>
          </CardHeader>
          <div className="p-4">
            {upcoming.length === 0 ? (
              <p className="text-sm text-muted-foreground">No dividends due in the next 30 days.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {upcoming.map((row) => (
                  <li
                    key={row.securityDividendId}
                    className="flex items-center justify-between gap-3 py-2 text-sm"
                  >
                    <span className="flex items-center gap-2">
                      <span className="font-medium">{row.symbol ?? '—'}</span>
                      <span className="text-xs text-muted-foreground">
                        pays {row.paymentDate}
                      </span>
                    </span>
                    <span className="text-muted-foreground">
                      {formatMoney(Number(row.perShareAmount), row.currency)}/sh
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </section>
    </div>
  )
}
