import { useMemo, useRef, useState } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  useNetWorthCurrent,
  useNetWorthSeries,
  updateOpeningBalance,
} from '@/hooks/useNetWorth'
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { formatMoney } from '@/lib/formatMoney'
import {
  fromDateInputValue,
  toDateInputValue,
  todayDateInputValue,
} from '@/lib/dateInput'

type Range = '1M' | '3M' | '1Y' | 'All'

function rangeToParams(range: Range): {
  from: string
  to: string
  granularity: 'monthly' | 'daily'
} {
  // Anchor at UTC midnight of the user's local calendar day so the picked
  // date matches what the user sees (issue #280). All date math uses UTC
  // setters to stay TZ-invariant.
  const todayUtc = fromDateInputValue(todayDateInputValue())!
  const to = toDateInputValue(todayUtc)
  const from = (() => {
    const d = new Date(todayUtc)
    if (range === '1M') d.setUTCDate(d.getUTCDate() - 31)
    else if (range === '3M') d.setUTCDate(d.getUTCDate() - 92)
    else if (range === '1Y') d.setUTCDate(d.getUTCDate() - 365)
    else d.setUTCFullYear(d.getUTCFullYear() - 20)
    return toDateInputValue(d)
  })()
  const granularity: 'monthly' | 'daily' =
    range === '1M' || range === '3M' ? 'daily' : 'monthly'
  return { from, to, granularity }
}

export function NetWorthPage() {
  const [range, setRange] = useState<Range>('1Y')
  const [editorOpen, setEditorOpen] = useState(false)
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [openingErrors, setOpeningErrors] = useState<Record<number, string>>({})
  const current = useNetWorthCurrent()
  const seriesParams = useMemo(() => rangeToParams(range), [range])
  const series = useNetWorthSeries(seriesParams)
  const editorRef = useRef<HTMLDivElement>(null)

  // Per-issue-262: build a set of asset accountIds so we can reject a
  // negative opening balance on asset-side accounts (the backend already
  // classifies via accountKind() — we surface that classification by which
  // breakdown bucket the row landed in).
  const assetAccountIds = useMemo(() => {
    const out = new Set<number>()
    for (const row of current.data?.breakdown.assets ?? []) {
      if (row.source === 'account' && row.accountId != null) out.add(row.accountId)
    }
    return out
  }, [current.data])

  async function saveOpening(accountId: number) {
    const raw = drafts[accountId] ?? ''
    const val = Number(raw)
    if (!Number.isFinite(val)) return
    if (assetAccountIds.has(accountId) && val < 0) {
      setOpeningErrors((prev) => ({
        ...prev,
        [accountId]: "Opening balance for an asset account can't be negative.",
      }))
      return
    }
    setOpeningErrors((prev) => {
      if (!(accountId in prev)) return prev
      const { [accountId]: _drop, ...rest } = prev
      void _drop
      return rest
    })
    await updateOpeningBalance(accountId, {
      openingBalance: val,
      openingBalanceDate: null,
    })
    current.refresh()
  }

  function openEditorAndScroll() {
    setEditorOpen(true)
    // Defer scroll so the editor is in the DOM before we measure it.
    setTimeout(() => editorRef.current?.scrollIntoView({ behavior: 'smooth' }), 0)
  }

  if (current.loading && !current.data) {
    return <div className="p-6">Loading net worth…</div>
  }

  const cur = current.data
  if (!cur) {
    return (
      <div className="p-6">
        <p>No data{current.error ? `: ${current.error.message}` : ''}.</p>
      </div>
    )
  }

  const accountRows = [...cur.breakdown.assets, ...cur.breakdown.liabilities]
  const editableAccounts = accountRows.filter(
    (r): r is typeof r & { accountId: number } =>
      r.source === 'account' && r.accountId != null,
  )
  const needsOpeningCount = editableAccounts.filter(
    (r) => !r.openingBalanceSet,
  ).length
  const negativeAssetCount = cur.breakdown.assets.filter(
    (r) => r.dataQualityWarning === 'asset_balance_negative',
  ).length
  const gapCurrencies = Array.from(
    new Set(
      cur.gaps
        .filter((g) => g.reason === 'fx_rate_unavailable')
        .map((g) => g.currency),
    ),
  )

  return (
    <div className="p-6 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Net worth</h1>
          <p className="text-sm text-muted-foreground">As of {cur.asOf}</p>
        </div>
        <div className="flex gap-1">
          {(['1M', '3M', '1Y', 'All'] as Range[]).map((r) => (
            <Button
              key={r}
              type="button"
              variant={range === r ? 'default' : 'outline'}
              size="sm"
              onClick={() => setRange(r)}
            >
              {r}
            </Button>
          ))}
        </div>
      </header>

      {needsOpeningCount > 0 && (
        <div
          role="alert"
          className="rounded border border-warning bg-warning-bg text-warning p-3 text-sm flex items-center justify-between gap-3"
        >
          <div>
            <strong>{needsOpeningCount}</strong> account
            {needsOpeningCount === 1 ? '' : 's'} ha
            {needsOpeningCount === 1 ? 's' : 've'} no opening balance set —
            derived totals will be off until you set them.
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={openEditorAndScroll}
            className="border-warning"
          >
            Set opening balances
          </Button>
        </div>
      )}

      {negativeAssetCount > 0 && (
        <div
          role="alert"
          className="rounded border border-warning bg-warning-bg text-warning p-3 text-sm"
        >
          <strong>{negativeAssetCount}</strong> asset account
          {negativeAssetCount === 1 ? '' : 's'} had a negative derived
          balance — excluded from the headline total. Check the rows
          flagged below.
        </div>
      )}

      {gapCurrencies.length > 0 && (
        <div
          role="alert"
          className="rounded border border-warning bg-warning-bg text-warning p-3 text-sm"
        >
          Missing FX rate{gapCurrencies.length === 1 ? '' : 's'} for{' '}
          <strong>{gapCurrencies.join(', ')}</strong> → CAD on {cur.asOf}.
          Those balances are excluded from the total.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded border p-4">
          <div className="text-sm text-muted-foreground">Net worth (CAD)</div>
          <div className="text-3xl font-semibold">
            {formatMoney(cur.total, 'CAD')}
          </div>
        </div>
        <div className="rounded border p-4">
          <div className="text-sm text-muted-foreground">Assets</div>
          <div className="text-2xl font-semibold">
            {formatMoney(cur.assetsTotal, 'CAD')}
          </div>
        </div>
        <div className="rounded border p-4">
          <div className="text-sm text-muted-foreground">Liabilities</div>
          <div className="text-2xl font-semibold">
            {formatMoney(cur.liabilitiesTotal, 'CAD')}
          </div>
        </div>
      </div>

      <div className="rounded border p-4">
        <div className="text-sm text-muted-foreground mb-2">
          Trend ({seriesParams.granularity})
        </div>
        <div className="h-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series.data?.points ?? []}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip
                formatter={(value) => {
                  const v = typeof value === 'number' ? value : Number(value)
                  return Number.isFinite(v) ? formatMoney(v, 'CAD') : ''
                }}
              />
              <Area type="monotone" dataKey="total" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="rounded border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Source</TableHead>
              <TableHead>Currency</TableHead>
              <TableHead className="text-right">Native</TableHead>
              <TableHead className="text-right">CAD value</TableHead>
              <TableHead>Notes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accountRows.map((row, i) => {
              const badges: string[] = []
              if (row.dataQualityWarning === 'asset_balance_negative') {
                badges.push('Negative — excluded')
              }
              if (row.source === 'account' && !row.openingBalanceSet) {
                badges.push('Opening balance not set')
              }
              return (
                <TableRow key={`${row.source}-${row.accountId}-${row.currency}-${i}`}>
                  <TableCell>{row.label}</TableCell>
                  <TableCell>{row.currency}</TableCell>
                  <TableCell className="text-right">
                    {row.native != null
                      ? formatMoney(row.native, row.currency)
                      : row.source === 'account' && !row.openingBalanceSet
                        ? <span className="text-xs text-warning">(unset)</span>
                        : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    {row.cadValue != null
                      ? formatMoney(row.cadValue, 'CAD')
                      : row.source === 'account' && !row.openingBalanceSet
                        ? <span className="text-xs text-warning">(unset)</span>
                        : '—'}
                  </TableCell>
                  <TableCell>
                    {badges.length === 0 ? (
                      ''
                    ) : (
                      <span className="text-xs text-warning">
                        {badges.join(' · ')}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      <div ref={editorRef} className="rounded border">
        <Button
          type="button"
          variant="ghost"
          onClick={() => setEditorOpen((v) => !v)}
          className="w-full text-left p-4 font-medium"
        >
          Opening balances {editorOpen ? '−' : '+'}
        </Button>
        {editorOpen && (
          <div className="p-4 space-y-3 border-t">
            {editableAccounts.length === 0 ? (
              <div className="text-sm text-muted-foreground">No accounts to edit.</div>
            ) : (
              editableAccounts.map((row) => (
                <div
                  key={`${row.accountId}-${row.currency}`}
                  className="flex flex-col gap-1"
                >
                  <div className="flex items-center gap-3">
                    <label
                      className="w-40 truncate"
                      htmlFor={`opening-${row.accountId}`}
                    >
                      {row.label}
                      {!row.openingBalanceSet && (
                        <span className="ml-2 text-xs text-warning">(unset)</span>
                      )}
                    </label>
                    <input
                      id={`opening-${row.accountId}`}
                      aria-label={`Opening balance for ${row.label}`}
                      type="number"
                      className="border rounded px-2 py-1"
                      aria-invalid={openingErrors[row.accountId] ? true : undefined}
                      aria-describedby={
                        openingErrors[row.accountId]
                          ? `opening-error-${row.accountId}`
                          : undefined
                      }
                      onChange={(e) =>
                        setDrafts((d) => ({
                          ...d,
                          [row.accountId]: e.target.value,
                        }))
                      }
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => saveOpening(row.accountId)}
                      aria-label={`Save ${row.label}`}
                    >
                      Save
                    </Button>
                  </div>
                  {openingErrors[row.accountId] && (
                    <span
                      id={`opening-error-${row.accountId}`}
                      className="error text-sm text-danger ml-40"
                      role="alert"
                    >
                      {openingErrors[row.accountId]}
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}
