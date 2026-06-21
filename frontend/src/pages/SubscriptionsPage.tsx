import { useEffect, useMemo, useState } from 'react'
import { Alert, Icon } from '@connor-adams/designsystem'
import { Badge } from '@connor-adams/designsystem'
import { Button } from '@connor-adams/designsystem'
import { Card } from '@connor-adams/designsystem'
import { CollapsibleCard } from '@/components/ui/collapsible-card'
import { Grid } from '@/lib/ds-extras'
import { SummaryStat } from '@/components/SummaryStat'
import { Dialog } from '@connor-adams/designsystem'
import { EmptyTableRow } from '@/lib/ds-extras'
import { NativeSelect } from '@connor-adams/designsystem'
import { PageHeader } from '@/components/ui/page-header'
import { SkeletonRow } from '@/lib/ds-extras'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@connor-adams/designsystem'
import { useToast } from '@/components/ui/toast'
import { CancelImpactCard } from '@/components/subscriptions/CancelImpactCard'
import { getJson, patchJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import type {
  CancelImpact,
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
  const [rowErrors, setRowErrors] = useState<Map<number, { message: string; retry: () => Promise<void> }>>(new Map())

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
      setRowErrors((prev) => { const m = new Map(prev); m.delete(id); return m; })
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
      const sub = data?.items.find((item) => item.id === id)
      setRowErrors((prev) => new Map(prev).set(id, {
        message,
        retry: () => updateStatus(id, status),
      }))
      showToast({
        title: `Couldn't update ${sub?.merchantName ?? 'subscription'}: ${message}`,
        variant: 'destructive',
      })
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

  const visibleItems = data?.items ?? []

  return (
    <div className="page">
      <PageHeader
        title="Subscriptions"
        description="Recurring charges grouped into manageable subscriptions. Mark each one active, cancelled, or ignored to keep this view useful."
      />

      <SubscriptionSummary summary={summary} loading={loading} />

      <Card className="mb-4">
        <div className="flex items-center gap-3">
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
      </Card>

      {err && (
        <Alert variant="error" className="mb-4">
          {err}
        </Alert>
      )}

      <CollapsibleCard
        id="subscriptions-list"
        title="Detected subscriptions"
        description="Each row is a recurring charge group detected from the last 180 days of activity. Status and cancellation URL are user-curated and preserved across refreshes."
      >
        <Table aria-busy={loading}>
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
                  onCadenceChange={updateCadence}
                  rowError={rowErrors.get(item.id)}
                />
              ))
            )}
          </TableBody>
        </Table>
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
      <Card className="mb-4" aria-busy="true">
        <p className="mb-4 text-sm leading-6 text-muted-foreground">
          Loading subscription totals…
        </p>
      </Card>
    )
  }
  if (!summary) return null

  const { totals, byCurrency } = summary
  return (
    <Card className="mb-4" aria-label="Subscription totals">
      <Grid minItemWidth={180} gap="md">
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
      </Grid>
    </Card>
  )
}

function SubscriptionRow({
  item,
  onStatusChange,
  onCadenceChange,
  rowError,
}: {
  item: Subscription
  onStatusChange: (id: number, status: SubscriptionStatus) => Promise<void>
  onCadenceChange: (id: number, cadence: SubscriptionCadence) => Promise<void>
  rowError?: { message: string; retry: () => Promise<void> }
}) {
  const annual = Number(item.annualizedCost)
  const amount = Number(item.amount)
  // Cancelled subscriptions are read-only: the cadence dropdown locks and the
  // cancel-impact preview is hidden (there's nothing left to save). (#291 AC #11)
  const isCancelled = item.status === 'cancelled'
  const [showImpact, setShowImpact] = useState(false)
  const [priceDrawerOpen, setPriceDrawerOpen] = useState(false)
  const [pendingChange, setPendingChange] = useState(item.pendingPriceChange)
  const { showToast } = useToast()

  async function acknowledgePriceChange() {
    if (!pendingChange) return
    try {
      // pendingChange.id is the Insight id (the price-increase signal is now a
      // subscription_price_increase Insight). Acknowledging dismisses it; the
      // chip + money-leak both read status:'open', so they clear immediately.
      await patchJson(`/api/insights/${pendingChange.id}`, { status: 'dismissed' })
      setPendingChange(null)
      setPriceDrawerOpen(false)
      showToast({ title: 'Acknowledged.' })
    } catch {
      showToast({ title: 'Failed to acknowledge', variant: 'destructive' })
    }
  }

  const pctNum = pendingChange ? parseFloat(pendingChange.pctChange) : 0
  const pctLabel = pendingChange
    ? `${pctNum >= 0 ? '↑' : '↓'} ${Math.abs(pctNum).toFixed(1)}%`
    : ''

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-1.5">
          {item.merchantName}
          {pendingChange ? (
            <Badge
              variant={pctNum >= 0 ? 'destructive' : 'default'}
              title={`Went from ${formatMoney(pendingChange.prevCents / 100, item.currency)} to ${formatMoney(pendingChange.newCents / 100, item.currency)} on ${pendingChange.detectedOn}`}
              className="cursor-pointer"
              onClick={() => setPriceDrawerOpen(true)}
            >
              Price {pctLabel}
            </Badge>
          ) : item.priceChangeDetected ? (
            <Badge
              variant="destructive"
              title="Price has increased since the last refresh"
            >
              <Icon name="alert-triangle" size={12} aria-hidden="true" /> price up
            </Badge>
          ) : null}
        </div>
        {priceDrawerOpen && pendingChange && (
          <Dialog
            open={priceDrawerOpen}
            onClose={() => setPriceDrawerOpen(false)}
            title={<>{item.merchantName} price changed</>}
            footer={
              <>
                <Button variant="outline" onClick={() => setPriceDrawerOpen(false)}>
                  Close
                </Button>
                <Button onClick={() => { void acknowledgePriceChange() }}>
                  Acknowledge
                </Button>
              </>
            }
          >
            <p>
              Previously {formatMoney(pendingChange.prevCents / 100, item.currency)} / month →
              {' '}Now {formatMoney(pendingChange.newCents / 100, item.currency)} / month.
              Detected from charges on {pendingChange.detectedOn}.
            </p>
          </Dialog>
        )}
        {item.cancellationUrl && (
          <a
            href={item.cancellationUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs"
          >
            cancel <Icon name="external-link" size={10} aria-hidden="true" />
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
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={STATUS_BADGE_VARIANT[item.status]}>
            {item.status}
          </Badge>
          <ReviewActions
            item={item}
            onStatusChange={onStatusChange}
            showImpact={showImpact}
            onToggleImpact={() => setShowImpact((v) => !v)}
          />
          {rowError && (
            <div className="flex items-center gap-1" role="alert">
              <span
                className="h-2 w-2 shrink-0 rounded-full bg-destructive"
                aria-hidden="true"
              />
              <span className="text-xs text-destructive">{rowError.message}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void rowError.retry()}
              >
                Retry
              </Button>
            </div>
          )}
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
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      title={<>Cancel {item.merchantName}?</>}
      footer={
        <>
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
        </>
      }
    >
      {savings
        ? `This saves ${savings} over the next ${impact?.horizonMonths ?? 12} months but you lose ${item.merchantName}.`
        : `This cancels ${item.merchantName}.`}
    </Dialog>
  )
}
