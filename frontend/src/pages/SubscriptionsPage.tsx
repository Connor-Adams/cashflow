import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ExternalLink } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CollapsibleCard } from '@/components/ui/collapsible-card'
import { EmptyTableRow } from '@/components/ui/empty-state'
import { NativeSelect } from '@/components/ui/native-select'
import { PageHeader } from '@/components/ui/page-header'
import { SkeletonRow } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useToast } from '@/components/ui/toast'
import { getJson, patchJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import type {
  Subscription,
  SubscriptionPatch,
  SubscriptionStatus,
  SubscriptionsResponse,
  SubscriptionsSummary,
} from '../types/api'

const STATUS_OPTIONS: ReadonlyArray<{
  value: SubscriptionStatus
  label: string
}> = [
  { value: 'active', label: 'Active' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'ignored', label: 'Ignored' },
  { value: 'unknown', label: 'Unknown' },
]

const STATUS_FILTER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'All statuses' },
  ...STATUS_OPTIONS,
]

/**
 * Tailwind variant lookup for status badges. The JIT compiler needs literal
 * class names — generating them at runtime via template strings would strip
 * them in production builds, so we keep the full classnames here.
 */
const STATUS_BADGE_VARIANT: Record<
  SubscriptionStatus,
  'default' | 'secondary' | 'outline' | 'destructive'
> = {
  active: 'default',
  cancelled: 'secondary',
  ignored: 'outline',
  unknown: 'outline',
}

const COLUMN_COUNT = 8

export function SubscriptionsPage() {
  const { showToast } = useToast()
  const [data, setData] = useState<SubscriptionsResponse | null>(null)
  const [summary, setSummary] = useState<SubscriptionsSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<string>('')

  const queryString = useMemo(() => {
    const params = new URLSearchParams()
    if (statusFilter) params.set('status', statusFilter)
    const s = params.toString()
    return s ? `?${s}` : ''
  }, [statusFilter])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setErr(null)
      try {
        const [list, sum] = await Promise.all([
          getJson<SubscriptionsResponse>(`/api/subscriptions${queryString}`),
          // Pass refresh=0 to summary so we don't run detection twice on a single page load.
          getJson<SubscriptionsSummary>(`/api/subscriptions/summary?refresh=0`),
        ])
        if (!cancelled) {
          setData(list)
          setSummary(sum)
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'Error')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [queryString])

  async function updateStatus(id: number, status: SubscriptionStatus) {
    try {
      const patch: SubscriptionPatch = { status }
      const updated = await patchJson<Subscription>(
        `/api/subscriptions/${id}`,
        patch,
      )
      setData((prev) =>
        prev
          ? {
              ...prev,
              items: prev.items.map((item) =>
                item.id === id ? updated : item,
              ),
            }
          : prev,
      )
      showToast({
        title: `Marked as ${status}`,
        variant: 'success',
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Update failed'
      showToast({ title: message, variant: 'destructive' })
    }
  }

  const visibleItems = data?.items ?? []

  return (
    <div className="page">
      <PageHeader
        title="Subscriptions"
        description="Recurring charges grouped into manageable subscriptions. Mark each one active, cancelled, or ignored to keep this view useful."
      />

      <SubscriptionSummary summary={summary} loading={loading} />

      <section className="card">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <label htmlFor="subscriptions-status-filter">Status</label>
          <NativeSelect
            id="subscriptions-status-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            {STATUS_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </NativeSelect>
        </div>
      </section>

      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}

      <CollapsibleCard
        id="subscriptions-list"
        title="Detected subscriptions"
        description="Each row is a recurring charge group detected from the last 180 days of activity. Status and cancellation URL are user-curated and preserved across refreshes."
      >
        <div className="tableWrap" aria-busy={loading}>
          <Table className="table">
            <TableHeader>
              <TableRow>
                <TableHead>Merchant</TableHead>
                <TableHead>Cadence</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Annual cost</TableHead>
                <TableHead>Last charged</TableHead>
                <TableHead>Next expected</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <SkeletonRow key={`subs-skeleton-${i}`} cols={COLUMN_COUNT} />
                ))
              ) : visibleItems.length === 0 ? (
                <EmptyTableRow
                  colSpan={COLUMN_COUNT}
                  title="No subscriptions detected yet."
                  description="Import more transaction history so the recurring detector has enough data, or check back after a few cycles."
                />
              ) : (
                visibleItems.map((item) => (
                  <SubscriptionRow
                    key={item.id}
                    item={item}
                    onStatusChange={updateStatus}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CollapsibleCard>
    </div>
  )
}

function SubscriptionSummary({
  summary,
  loading,
}: {
  summary: SubscriptionsSummary | null
  loading: boolean
}) {
  if (loading && !summary) {
    return (
      <section className="card" aria-busy="true">
        <p className="muted">Loading subscription totals…</p>
      </section>
    )
  }
  if (!summary) return null

  const { totals, byCurrency } = summary
  return (
    <section className="card" aria-label="Subscription totals">
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 12,
        }}
      >
        <SummaryStat label="Active" value={String(totals.active)} />
        <SummaryStat label="Ignored" value={String(totals.ignored)} />
        <SummaryStat label="Cancelled" value={String(totals.cancelled)} />
        <SummaryStat
          label="Price increases"
          value={String(totals.priceChangeDetected)}
          tone={totals.priceChangeDetected > 0 ? 'warn' : undefined}
        />
        {byCurrency.map((row) => (
          <SummaryStat
            key={`monthly-${row.currency}`}
            label={`Monthly (${row.currency})`}
            value={formatMoney(row.monthlyCost, row.currency)}
          />
        ))}
        {byCurrency.map((row) => (
          <SummaryStat
            key={`annual-${row.currency}`}
            label={`Annual (${row.currency})`}
            value={formatMoney(row.annualCost, row.currency)}
          />
        ))}
      </div>
    </section>
  )
}

function SummaryStat({
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
          color: tone === 'warn' ? 'var(--accent-warm, #b45309)' : undefined,
        }}
      >
        {value}
      </div>
    </Card>
  )
}

function SubscriptionRow({
  item,
  onStatusChange,
}: {
  item: Subscription
  onStatusChange: (id: number, status: SubscriptionStatus) => Promise<void>
}) {
  const annual = Number(item.annualizedCost)
  const amount = Number(item.amount)

  return (
    <TableRow>
      <TableCell>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {item.merchantName}
          {item.priceChangeDetected && (
            <Badge
              variant="destructive"
              title="Price has increased since the last refresh"
            >
              <AlertTriangle size={12} aria-hidden="true" /> price up
            </Badge>
          )}
        </div>
        {item.cancellationUrl && (
          <a
            href={item.cancellationUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: 12,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            cancel <ExternalLink size={10} aria-hidden="true" />
          </a>
        )}
      </TableCell>
      <TableCell>
        <Badge variant={item.cadence === 'monthly' ? 'default' : 'secondary'}>
          {item.cadence}
        </Badge>
      </TableCell>
      <TableCell>{formatMoney(amount, item.currency)}</TableCell>
      <TableCell>{formatMoney(annual, item.currency)}</TableCell>
      <TableCell>{item.lastChargeDate}</TableCell>
      <TableCell>{item.nextExpectedDate ?? '—'}</TableCell>
      <TableCell>{item.category ?? '—'}</TableCell>
      <TableCell>
        <div
          style={{
            display: 'flex',
            gap: 6,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <Badge variant={STATUS_BADGE_VARIANT[item.status]}>
            {item.status}
          </Badge>
          <ReviewActions item={item} onStatusChange={onStatusChange} />
        </div>
      </TableCell>
    </TableRow>
  )
}

function ReviewActions({
  item,
  onStatusChange,
}: {
  item: Subscription
  onStatusChange: (id: number, status: SubscriptionStatus) => Promise<void>
}) {
  // "Review this" surfaces the most-useful next actions: if the user is
  // looking at an active subscription, the meaningful actions are to
  // cancel or ignore it. For an ignored/cancelled subscription, the
  // meaningful action is to reactivate.
  const nextStatuses: SubscriptionStatus[] =
    item.status === 'active'
      ? ['cancelled', 'ignored']
      : item.status === 'unknown'
        ? ['active', 'cancelled', 'ignored']
        : ['active']

  return (
    <>
      {nextStatuses.map((s) => (
        <Button
          key={s}
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            void onStatusChange(item.id, s)
          }}
        >
          mark {s}
        </Button>
      ))}
    </>
  )
}
