/**
 * Per-merchant detail (issue #219).
 *
 * Composes GET /api/merchants/:name + GET /api/merchants/:name/transactions
 * into a single page showing:
 *   - lifetime totals (spend, credits, net, count, average, first/last)
 *   - monthly trend chart
 *   - per-category split
 *   - receipt coverage stat
 *   - related rules + recurring badge
 *   - transactions table (paginated)
 *
 * Loading pattern mirrors PortfolioSecurityPage: useState + useEffect +
 * Promise.all on getJson. Currency filter is a simple <select> driven by
 * the available currencies returned in the detail payload.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyTableRow } from '@/components/ui/empty-state'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { getJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'

type MonthlyBucket = {
  month: string
  totalSpend: number
  totalCredits: number
  netSpend: number
  transactionCount: number
}

type CategoryBucket = {
  category: string | null
  totalSpend: number
  transactionCount: number
}

type ReceiptCoverage = {
  totalCount: number
  withReceiptCount: number
  missingCount: number
  coverageByCount: number
}

type RelatedRule = {
  id: number
  merchantPattern: string
  matchKind: string
  category: string | null
  priority: number
}

type MerchantDetail = {
  merchant: string
  currency: string | null
  availableCurrencies: string[]
  totals: {
    totalSpend: number
    totalCredits: number
    netSpend: number
    transactionCount: number
    averageTransaction: number
    firstDate: string | null
    lastDate: string | null
  }
  monthlyTrend: MonthlyBucket[]
  byCategory: CategoryBucket[]
  receiptCoverage: ReceiptCoverage
  isRecurring: boolean
  relatedRules: RelatedRule[]
}

type MerchantTransaction = {
  id: number
  date: string
  merchantClean: string | null
  merchantRaw: string | null
  amount: number
  currency: string
  finalCategory: string | null
  receiptCount: number
  account?: { id: number; name: string; shortCode: string | null } | null
}

type TransactionsPage = {
  data: MerchantTransaction[]
  page: number
  pageSize: number
  total: number
}

const PAGE_SIZE = 25

function formatPct(fraction: number): string {
  if (!Number.isFinite(fraction)) return '—'
  return `${Math.round(fraction * 100)}%`
}

function categoryLabel(category: string | null): string {
  return category && category.trim() ? category : 'Uncategorized'
}

export function MerchantPage() {
  const params = useParams<{ name: string }>()
  // useParams already URL-decodes the path segment.
  const name = params.name ?? ''
  const [detail, setDetail] = useState<MerchantDetail | null>(null)
  const [txns, setTxns] = useState<TransactionsPage | null>(null)
  const [currency, setCurrency] = useState<string>('')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [txnLoading, setTxnLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const detailQuery = currency ? `?currency=${encodeURIComponent(currency)}` : ''
  const detailPath = `/api/merchants/${encodeURIComponent(name)}${detailQuery}`

  const loadDetail = useCallback(async () => {
    if (!name) return
    setLoading(true)
    setErr(null)
    try {
      const d = await getJson<MerchantDetail>(detailPath)
      setDetail(d)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load merchant detail')
    } finally {
      setLoading(false)
    }
  }, [name, detailPath])

  const loadTxns = useCallback(async () => {
    if (!name) return
    setTxnLoading(true)
    try {
      const q = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
      })
      if (currency) q.set('currency', currency)
      const t = await getJson<TransactionsPage>(
        `/api/merchants/${encodeURIComponent(name)}/transactions?${q.toString()}`,
      )
      setTxns(t)
    } catch {
      // Detail-load error already surfaced; don't override it.
    } finally {
      setTxnLoading(false)
    }
  }, [name, currency, page])

  useEffect(() => {
    void loadDetail()
  }, [loadDetail])

  useEffect(() => {
    void loadTxns()
  }, [loadTxns])

  // Reset page-1 whenever the currency filter changes so the user always
  // lands on the first page of the filtered set.
  useEffect(() => {
    setPage(1)
  }, [currency])

  const trendData = useMemo(() => {
    if (!detail) return []
    return detail.monthlyTrend.map((m) => ({
      month: m.month,
      netSpend: m.netSpend,
      totalSpend: m.totalSpend,
    }))
  }, [detail])

  if (!name) {
    return (
      <div className="page">
        <PageHeader title="Merchant" />
        <p className="error">Missing merchant name.</p>
      </div>
    )
  }
  if (loading && !detail) {
    return (
      <div className="page">
        <PageHeader title={`Loading ${name}…`} />
      </div>
    )
  }
  if (err) {
    return (
      <div className="page">
        <PageHeader
          title={name}
          actions={
            <Link to="/transactions">
              <Button variant="outline">Back to transactions</Button>
            </Link>
          }
        />
        <p className="error">{err}</p>
      </div>
    )
  }
  if (!detail) {
    return (
      <div className="page">
        <PageHeader title={name} />
        <p className="muted">No data for merchant.</p>
      </div>
    )
  }

  const headerCurrency = currency || detail.availableCurrencies[0] || 'CAD'

  return (
    <div className="page">
      <PageHeader
        title={detail.merchant}
        description={
          detail.totals.firstDate && detail.totals.lastDate
            ? `${detail.totals.firstDate} → ${detail.totals.lastDate}`
            : undefined
        }
        actions={
          <Link to="/transactions">
            <Button variant="outline">Back to transactions</Button>
          </Link>
        }
      />

      <div className="flex flex-wrap items-center gap-3 mt-2">
        {detail.isRecurring && (
          <Badge variant="secondary" aria-label="Recurring merchant">
            Recurring
          </Badge>
        )}
        {detail.availableCurrencies.length > 1 ? (
          <label className="flex items-center gap-2 text-sm">
            <span className="muted">Currency</span>
            <NativeSelect
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              aria-label="Filter by currency"
            >
              <NativeSelectOption value="">All</NativeSelectOption>
              {detail.availableCurrencies.map((c) => (
                <NativeSelectOption key={c} value={c}>
                  {c}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
        ) : null}
      </div>

      <section className="transactionsStats mt-4">
        <StatCard
          label="Lifetime spend"
          value={formatMoney(detail.totals.totalSpend, headerCurrency)}
          hint={
            currency
              ? `Filtered to ${currency}`
              : detail.availableCurrencies.length > 1
                ? 'Across currencies'
                : undefined
          }
        />
        <StatCard
          label="Net (after credits)"
          value={formatMoney(detail.totals.netSpend, headerCurrency)}
          hint={`Credits: ${formatMoney(detail.totals.totalCredits, headerCurrency)}`}
        />
        <StatCard
          label="Average transaction"
          value={formatMoney(detail.totals.averageTransaction, headerCurrency)}
          hint="Per spend row"
        />
        <StatCard
          label="Transactions"
          value={String(detail.totals.transactionCount)}
          hint={`${detail.byCategory.length} categories`}
        />
        <StatCard
          label="Receipt coverage"
          value={formatPct(detail.receiptCoverage.coverageByCount)}
          hint={`${detail.receiptCoverage.withReceiptCount}/${detail.receiptCoverage.totalCount} attached`}
        />
      </section>

      <Card className="mt-4 p-4">
        <p className="statLabel mb-2">Monthly trend</p>
        {trendData.length === 0 ? (
          <p className="muted mb-0">No spend yet.</p>
        ) : (
          <div style={{ width: '100%', height: 220 }}>
            <ResponsiveContainer>
              <LineChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip
                  formatter={(value) =>
                    typeof value === 'number'
                      ? formatMoney(value, headerCurrency)
                      : String(value)
                  }
                />
                <Line
                  type="monotone"
                  dataKey="netSpend"
                  name="Net spend"
                  stroke="var(--chart-1, #4f46e5)"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="totalSpend"
                  name="Gross spend"
                  stroke="var(--chart-2, #94a3b8)"
                  strokeWidth={1}
                  dot={false}
                  strokeDasharray="4 4"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      <Card className="mt-4 p-4">
        <p className="statLabel mb-2">By category</p>
        {detail.byCategory.length === 0 ? (
          <p className="muted mb-0">No category data.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Spend</TableHead>
                <TableHead className="text-right">Count</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.byCategory.map((c) => (
                <TableRow key={c.category ?? '__null__'}>
                  <TableCell>{categoryLabel(c.category)}</TableCell>
                  <TableCell className="text-right">
                    {formatMoney(c.totalSpend, headerCurrency)}
                  </TableCell>
                  <TableCell className="text-right">{c.transactionCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card className="mt-4 p-4">
        <p className="statLabel mb-2">Related rules</p>
        {detail.relatedRules.length === 0 ? (
          <p className="muted mb-0">
            No rules match this merchant. <Link to="/rules">Add one</Link>
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pattern</TableHead>
                <TableHead>Match kind</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Priority</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.relatedRules.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.merchantPattern}</TableCell>
                  <TableCell>{r.matchKind}</TableCell>
                  <TableCell>{r.category ?? '—'}</TableCell>
                  <TableCell className="text-right">{r.priority}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card className="mt-4 p-4">
        <div className="flex items-center justify-between mb-2">
          <p className="statLabel mb-0">Transactions</p>
          <p className="muted text-xs mb-0">
            {txns ? `${txns.total} total` : ''}
          </p>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Merchant</TableHead>
              <TableHead>Account</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="text-right">Receipt</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {txnLoading && (!txns || txns.data.length === 0) ? (
              <EmptyTableRow colSpan={6} title="Loading…" />
            ) : !txns || txns.data.length === 0 ? (
              <EmptyTableRow
                colSpan={6}
                title="No transactions"
                description="There are no transactions for this merchant in the current filter."
              />
            ) : (
              txns.data.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>{t.date}</TableCell>
                  <TableCell title={t.merchantRaw ?? undefined}>{t.merchantClean ?? t.merchantRaw ?? '—'}</TableCell>
                  <TableCell>{t.account?.shortCode ?? t.account?.name ?? '—'}</TableCell>
                  <TableCell>{t.finalCategory ?? '—'}</TableCell>
                  <TableCell className="text-right">{formatMoney(t.amount, t.currency)}</TableCell>
                  <TableCell className="text-right">
                    {t.receiptCount > 0 ? `${t.receiptCount}` : '—'}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        {txns && txns.total > PAGE_SIZE ? (
          <div className="flex items-center justify-between mt-3 text-sm">
            <span className="muted">
              Page {txns.page} of {Math.max(1, Math.ceil(txns.total / PAGE_SIZE))}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1 || txnLoading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page * PAGE_SIZE >= txns.total || txnLoading}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  )
}
