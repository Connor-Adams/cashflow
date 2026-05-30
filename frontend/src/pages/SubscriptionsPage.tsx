import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ExternalLink, TrendingUp } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CollapsibleCard } from '@/components/ui/collapsible-card'
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { CancelImpactCard } from '@/components/subscriptions/CancelImpactCard'
import { PriceChangeChip } from '@/components/subscriptions/PriceChangeChip'
import { PriceChangeDrawer } from '@/components/subscriptions/PriceChangeDrawer'
import { getJson, patchJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import type {
  CancelImpact,
  PendingPriceChange,
  Subscription,
  SubscriptionCadence,
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

/**
 * Cadence options for the per-row dropdown. Labels per the #291 copy spec:
 * Weekly / Monthly / Quarterly / Semi-annual / Annual.
 */
const CADENCE_OPTIONS: ReadonlyArray<{
  value: SubscriptionCadence
  label: string
}> = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'semiannual', label: 'Semi-annual' },
  { value: 'annual', label: 'Annual' },
]

const CADENCE_LABEL: Record<SubscriptionCadence, string> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  semiannual: 'Semi-annual',
  annual: 'Annual',
}

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
  const [priceChangeFilter, setPriceChangeFilter] = useState(false)
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({})
  const [drawerChange, setDrawerChange] = useState<{
    change: PendingPriceChange
    subscriptionName: string
  } | null>(null)

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
    const name = data?.items.find((item) => item.id === id)?.merchantName ?? String(id)
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
      setRowErrors((prev) => { const next = { ...prev }; delete next[id]; return next })
      showToast({
        title: `Marked as ${status}`,
        variant: 'success',
      })
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'Update failed'
      setRowErrors((prev) => ({ ...prev, [id]: reason }))
      showToast({ title: `Couldn't update ${name}: ${reason}`, variant: 'destructive' })
    }
  }

  async function updateCadence(id: number, cadence: SubscriptionCadence) {
    // Optimistically reflect the new cadence so the row's cancel-impact card
    // refetches immediately; on failure we revert and surface a retry toast.
    const previous = data?.items.find((item) => item.id === id)?.cadence
    setData((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.map((item) =>
              item.id === id ? { ...item, cadence } : item,
            ),
          }
        : prev,
    )
    try {
      const patch: SubscriptionPatch = { cadence }
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
        title: `Updated cadence to ${CADENCE_LABEL[cadence]}.`,
        variant: 'success',
      })
    } catch {
      // Revert the optimistic change.
      if (previous) {
        setData((prev) =>
          prev
            ? {
                ...prev,
                items: prev.items.map((item) =>
                  item.id === id ? { ...item, cadence: previous } : item,
                ),
              }
            : prev,
        )
      }
      showToast({
        title: "Couldn't update cadence. Try again.",
        variant: 'destructive',
        action: {
          label: 'Retry',
          onClick: () => {
            void updateCadence(id, cadence)
          },
        },
      })
    }
  }

  function handlePriceChangeAcknowledged(changeId: number) {
    setData((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.map((item) =>
              item.pendingPriceChange?.id === changeId
                ? { ...item, pendingPriceChange: null }
                : item,
            ),
          }
        : prev,
    )
    setDrawerChange(null)
  }

  const allItems = data?.items ?? []
  const visibleItems = priceChangeFilter
    ? allItems.filter((item) => item.pendingPriceChange != null)
    : allItems

  return (
    <div className="page">
      <PageHeader
        title="Subscriptions"
        description="Recurring charges grouped into manageable subscriptions. Mark each one active, cancelled, or ignored to keep this view useful."
      />

      <SubscriptionSummary summary={summary} loading={loading} />

      <section className="card">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
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
          <Button
            type="button"
            size="sm"
            variant={priceChangeFilter ? 'default' : 'outline'}
            onClick={() => setPriceChangeFilter((v) => !v)}
          >
            <TrendingUp size={14} aria-hidden="true" />
            Price changes only
          </Button>
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
                    rowError={rowErrors[item.id] ?? null}
                    onStatusChange={updateStatus}
                    onCadenceChange={updateCadence}
                    onPriceChangeClick={(change) =>
                      setDrawerChange({ change, subscriptionName: item.merchantName })
                    }
                  />
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CollapsibleCard>

      {drawerChange && (
        <PriceChangeDrawer
          subscriptionName={drawerChange.subscriptionName}
          change={drawerChange.change}
          open={drawerChange != null}
          onOpenChange={(open) => { if (!open) setDrawerChange(null) }}
          onAcknowledged={handlePriceChangeAcknowledged}
        />
      )}
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
  rowError,
  onStatusChange,
  onCadenceChange,
  onPriceChangeClick,
}: {
  item: Subscription
  rowError: string | null
  onStatusChange: (id: number, status: SubscriptionStatus) => Promise<void>
  onCadenceChange: (id: number, cadence: SubscriptionCadence) => Promise<void>
  onPriceChangeClick: (change: NonNullable<Subscription['pendingPriceChange']>) => void
}) {
  const annual = Number(item.annualizedCost)
  const amount = Number(item.amount)
  // Cancelled subscriptions are read-only: the cadence dropdown locks and the
  // cancel-impact preview is hidden (there's nothing left to save). (#291 AC #11)
  const isCancelled = item.status === 'cancelled'
  const [showImpact, setShowImpact] = useState(false)

  return (
    <TableRow>
      <TableCell>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {item.merchantName}
          {item.pendingPriceChange ? (
            <PriceChangeChip
              change={item.pendingPriceChange}
              onClick={() => onPriceChangeClick(item.pendingPriceChange!)}
            />
          ) : item.priceChangeDetected ? (
            <Badge
              variant="destructive"
              title="Price has increased since the last refresh"
            >
              <AlertTriangle size={12} aria-hidden="true" /> price up
            </Badge>
          ) : null}
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
        {isCancelled ? (
          <Badge variant="secondary">{CADENCE_LABEL[item.cadence]}</Badge>
        ) : (
          <NativeSelect
            size="sm"
            aria-label={`Cadence for ${item.merchantName}`}
            value={item.cadence}
            onChange={(e) => {
              void onCadenceChange(
                item.id,
                e.target.value as SubscriptionCadence,
              )
            }}
          >
            {CADENCE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </NativeSelect>
        )}
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
          {rowError && (
            <>
              <span
                className="inline-block size-2 rounded-full bg-red-500 flex-shrink-0"
                title={rowError}
                aria-label={`Error: ${rowError}`}
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  void onStatusChange(item.id, item.status)
                }}
              >
                Retry
              </Button>
            </>
          )}
          <ReviewActions
            item={item}
            onStatusChange={onStatusChange}
            showImpact={showImpact}
            onToggleImpact={() => setShowImpact((v) => !v)}
          />
        </div>
        {!isCancelled && showImpact && (
          <CancelImpactCard
            subscriptionId={item.id}
            refetchKey={item.cadence}
          />
        )}
      </TableCell>
    </TableRow>
  )
}

function ReviewActions({
  item,
  onStatusChange,
  showImpact,
  onToggleImpact,
}: {
  item: Subscription
  onStatusChange: (id: number, status: SubscriptionStatus) => Promise<void>
  showImpact: boolean
  onToggleImpact: () => void
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

  const [confirmOpen, setConfirmOpen] = useState(false)

  return (
    <>
      {item.status !== 'cancelled' && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-expanded={showImpact}
          onClick={onToggleImpact}
        >
          {showImpact ? 'hide impact' : 'cancel impact'}
        </Button>
      )}
      {nextStatuses.map((s) =>
        s === 'cancelled' ? (
          <Button
            key={s}
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setConfirmOpen(true)}
          >
            mark {s}
          </Button>
        ) : (
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
        ),
      )}
      <CancelConfirmDialog
        item={item}
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={() => {
          setConfirmOpen(false)
          void onStatusChange(item.id, 'cancelled')
        }}
      />
    </>
  )
}

/**
 * Confirmation dialog shown before marking a subscription cancelled (#291 AC
 * #10). Fetches the 12-month cancel-impact so the user sees what they'd save
 * before confirming. Defaults to the 12-month horizon — the inline card is
 * where horizon exploration happens.
 */
function CancelConfirmDialog({
  item,
  open,
  onOpenChange,
  onConfirm,
}: {
  item: Subscription
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  const [impact, setImpact] = useState<CancelImpact | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setImpact(null)
    ;(async () => {
      try {
        const res = await getJson<CancelImpact>(
          `/api/subscriptions/${item.id}/cancel-impact?horizonMonths=12`,
        )
        if (!cancelled) setImpact(res)
      } catch {
        // If the impact can't be fetched we still let the user cancel; the
        // dialog just omits the savings figure.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, item.id])

  const savings = impact
    ? formatMoney(impact.amount, impact.currency)
    : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogHeader>
        <DialogTitle>Cancel {item.merchantName}?</DialogTitle>
      </DialogHeader>
      <DialogBody>
        {savings
          ? `This saves ${savings} over the next ${impact?.horizonMonths ?? 12} months but you lose ${item.merchantName}.`
          : `This cancels ${item.merchantName}.`}
      </DialogBody>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenChange(false)}
        >
          Keep it
        </Button>
        <Button type="button" variant="destructive" onClick={onConfirm}>
          Cancel subscription
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
