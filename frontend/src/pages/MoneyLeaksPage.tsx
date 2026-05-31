import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Droplet, Repeat, Truck, Users, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CollapsibleCard } from '@/components/ui/collapsible-card'
import { NativeSelect } from '@/components/ui/native-select'
import { PageHeader } from '@/components/ui/page-header'
import { useToast } from '@/components/ui/toast'
import { deleteReq, getJson, postJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import type {
  MoneyLeakDismissedResponse,
  MoneyLeakItem,
  MoneyLeakSeverity,
  MoneyLeakType,
  MoneyLeaksResponse,
} from '../types/api'

/**
 * MoneyLeaksPage — surfaces detected money leaks for the active household
 * (Cashflow #220). Leaks are deterministic from existing data (subscriptions
 * + recurring charges + trailing delivery spend); the page renders them in
 * cards grouped by type with monthly + annual impact totals at the top.
 * Users can dismiss individual leaks; dismissals are persisted server-side
 * and the same row is hidden on subsequent reads. Dismissed items can be
 * undismissed from the "Dismissed" section at the bottom.
 */

/**
 * Tailwind variant lookup for severity badges. JIT needs literal classes,
 * so we keep the variant -> classname map explicit rather than
 * concatenating at render time.
 */
const SEVERITY_BADGE_VARIANT: Record<
  MoneyLeakSeverity,
  'default' | 'secondary' | 'outline' | 'destructive'
> = {
  high: 'destructive',
  medium: 'default',
  low: 'secondary',
}

const TYPE_ICON: Record<MoneyLeakType, typeof Droplet> = {
  subscription_price_increase: AlertTriangle,
  small_subscription: Droplet,
  recurring_fee: Repeat,
  duplicate_service: Users,
  delivery_fee_high: Truck,
}

const TYPE_LABEL: Record<MoneyLeakType, string> = {
  subscription_price_increase: 'Subscription price increases',
  small_subscription: 'Small subscriptions',
  recurring_fee: 'Recurring fees',
  duplicate_service: 'Duplicate services',
  delivery_fee_high: 'Delivery fees',
}

const TYPE_ORDER: MoneyLeakType[] = [
  'subscription_price_increase',
  'duplicate_service',
  'recurring_fee',
  'delivery_fee_high',
  'small_subscription',
]

export function MoneyLeaksPage() {
  const { showToast } = useToast()
  const [data, setData] = useState<MoneyLeaksResponse | null>(null)
  const [dismissed, setDismissed] = useState<MoneyLeakDismissedResponse | null>(
    null,
  )
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [currencyFilter, setCurrencyFilter] = useState<string>('')

  // Use the dismissed list to compute the available currency options so the
  // filter doesn't depend on a particular leak being visible.
  const queryString = useMemo(() => {
    const params = new URLSearchParams()
    if (currencyFilter) params.set('currency', currencyFilter)
    const s = params.toString()
    return s ? `?${s}` : ''
  }, [currencyFilter])

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const [list, dis] = await Promise.all([
        getJson<MoneyLeaksResponse>(`/api/money-leaks${queryString}`),
        getJson<MoneyLeakDismissedResponse>(`/api/money-leaks/dismissed`),
      ])
      setData(list)
      setDismissed(dis)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Error')
    } finally {
      setLoading(false)
    }
  }, [queryString])

  useEffect(() => {
    void load()
  }, [load])

  async function dismiss(item: MoneyLeakItem) {
    try {
      await postJson(`/api/money-leaks/dismiss`, {
        leakType: item.leakType,
        identityKey: item.identityKey,
        snapshot: {
          title: item.title,
          currency: item.currency,
          annualImpact: item.annualImpact,
          monthlyImpact: item.monthlyImpact,
        },
      })
      showToast({
        title: `Dismissed: ${item.title}`,
        variant: 'success',
      })
      await load()
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Dismiss failed'
      showToast({ title: message, variant: 'destructive' })
    }
  }

  async function undismiss(id: number) {
    try {
      await deleteReq(`/api/money-leaks/dismiss/${id}`)
      showToast({ title: 'Restored', variant: 'success' })
      await load()
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Undismiss failed'
      showToast({ title: message, variant: 'destructive' })
    }
  }

  const visibleItems = useMemo(() => data?.items ?? [], [data])

  // Build the set of currencies we know about so the filter is populated.
  const availableCurrencies = useMemo(() => {
    const set = new Set<string>()
    for (const c of data?.totals.byCurrency ?? []) set.add(c.currency)
    for (const d of dismissed?.items ?? []) {
      const cur =
        d.snapshot && typeof d.snapshot === 'object' && 'currency' in d.snapshot
          ? String((d.snapshot as { currency?: unknown }).currency ?? '')
          : ''
      if (cur) set.add(cur)
    }
    return Array.from(set).sort()
  }, [data, dismissed])

  // Group visible items by leakType so each card holds a single type.
  const grouped = useMemo(() => {
    const map = new Map<MoneyLeakType, MoneyLeakItem[]>()
    for (const item of visibleItems) {
      const list = map.get(item.leakType) ?? []
      list.push(item)
      map.set(item.leakType, list)
    }
    return map
  }, [visibleItems])

  return (
    <div className="page">
      <PageHeader
        title="Money leaks"
        description="Small recurring costs, fees, and patterns worth reviewing. Dismiss leaks you've handled — they won't come back."
      />

      <LeakTotals
        data={data}
        loading={loading}
      />

      <section className="card">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <label htmlFor="money-leaks-currency-filter">Currency</label>
          <NativeSelect
            id="money-leaks-currency-filter"
            value={currencyFilter}
            onChange={(e) => setCurrencyFilter(e.target.value)}
          >
            <option value="">All currencies</option>
            {availableCurrencies.map((c) => (
              <option key={c} value={c}>
                {c}
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

      {loading && !data ? (
        <section className="card" aria-busy="true">
          <p className="muted">Looking for leaks…</p>
        </section>
      ) : visibleItems.length === 0 ? (
        <section className="card">
          <p className="muted">
            No leaks detected. Either your spending is dialled in or there
            isn't enough recent history to flag anything yet.
          </p>
        </section>
      ) : (
        TYPE_ORDER.filter((t) => grouped.has(t)).map((leakType) => (
          <LeakGroup
            key={leakType}
            leakType={leakType}
            items={grouped.get(leakType) ?? []}
            onDismiss={dismiss}
          />
        ))
      )}

      {dismissed && dismissed.items.length > 0 && (
        <CollapsibleCard
          id="money-leaks-dismissed"
          title="Dismissed leaks"
          description="Restore one to make it visible again."
          defaultOpen={false}
        >
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {dismissed.items.map((d) => (
              <li
                key={d.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '6px 0',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <span>
                  <Badge variant="outline">{TYPE_LABEL[d.leakType]}</Badge>{' '}
                  {d.snapshot && typeof d.snapshot === 'object' && 'title' in d.snapshot
                    ? String((d.snapshot as { title?: unknown }).title ?? d.identityKey)
                    : d.identityKey}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void undismiss(d.id)
                  }}
                >
                  restore
                </Button>
              </li>
            ))}
          </ul>
        </CollapsibleCard>
      )}
    </div>
  )
}

function LeakTotals({
  data,
  loading,
}: {
  data: MoneyLeaksResponse | null
  loading: boolean
}) {
  if (loading && !data) {
    return (
      <section className="card" aria-busy="true">
        <p className="muted">Loading totals…</p>
      </section>
    )
  }
  if (!data) return null
  const { byCurrency } = data.totals

  // Combined per-currency summary stats. We never collapse currencies — a
  // CAD + USD mix would be misleading if simply summed.
  return (
    <section className="card" aria-label="Money-leak totals">
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 12,
        }}
      >
        <SummaryStat
          label="Leaks detected"
          value={String(data.items.length)}
        />
        {byCurrency.length === 0 && data.items.length === 0 ? null : (
          <>
            {byCurrency.map((c) => (
              <SummaryStat
                key={`monthly-${c.currency}`}
                label={`Monthly (${c.currency})`}
                value={formatMoney(c.monthlyImpact, c.currency)}
                tone="warn"
              />
            ))}
            {byCurrency.map((c) => (
              <SummaryStat
                key={`annual-${c.currency}`}
                label={`Annual (${c.currency})`}
                value={formatMoney(c.annualImpact, c.currency)}
                tone="warn"
              />
            ))}
          </>
        )}
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

function LeakGroup({
  leakType,
  items,
  onDismiss,
}: {
  leakType: MoneyLeakType
  items: MoneyLeakItem[]
  onDismiss: (item: MoneyLeakItem) => Promise<void>
}) {
  const Icon = TYPE_ICON[leakType]
  const groupAnnual = items.reduce((s, i) => s + i.annualImpact, 0)
  const groupCurrencies = Array.from(new Set(items.map((i) => i.currency)))
  return (
    <CollapsibleCard
      id={`money-leaks-group-${leakType}`}
      title={TYPE_LABEL[leakType]}
      description={`${items.length} ${items.length === 1 ? 'leak' : 'leaks'} • ${groupCurrencies.length === 1 ? `${groupAnnual.toFixed(2)} ${groupCurrencies[0]}/year` : `${groupCurrencies.length} currencies`}`}
    >
      <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {items.map((item) => (
          <li
            key={`${item.leakType}|${item.identityKey}`}
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr auto',
              gap: 12,
              alignItems: 'start',
              padding: '12px 0',
              borderBottom: '1px solid var(--border)',
            }}
          >
            <Icon aria-hidden="true" size={20} style={{ marginTop: 2 }} />
            <div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontWeight: 600,
                }}
              >
                {item.title}
                <Badge variant={SEVERITY_BADGE_VARIANT[item.severity]}>
                  {item.severity}
                </Badge>
              </div>
              <div className="muted" style={{ fontSize: 14, marginTop: 4 }}>
                {item.description}
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                {formatMoney(item.monthlyImpact, item.currency)}/mo •{' '}
                {formatMoney(item.annualImpact, item.currency)}/yr
              </div>
              {(item.leakType === 'subscription_price_increase' ||
                item.leakType === 'small_subscription' ||
                item.leakType === 'duplicate_service') && (
                <Link
                  to="/subscriptions"
                  className="muted text-xs underline"
                  style={{ marginTop: 4, display: 'inline-block' }}
                >
                  View source →
                </Link>
              )}
              {item.leakType === 'recurring_fee' && (
                <Link
                  to="/recurring"
                  className="muted text-xs underline"
                  style={{ marginTop: 4, display: 'inline-block' }}
                >
                  View source →
                </Link>
              )}
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                void onDismiss(item)
              }}
              aria-label={`Dismiss ${item.title}`}
            >
              <X size={14} aria-hidden="true" /> dismiss
            </Button>
          </li>
        ))}
      </ul>
    </CollapsibleCard>
  )
}
