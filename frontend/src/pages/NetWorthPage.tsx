import { useMemo, useState } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useNetWorthCurrent, useNetWorthSeries, updateOpeningBalance } from '@/hooks/useNetWorth'
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table'
import { formatMoney } from '@/lib/formatMoney'

type Range = '1M' | '3M' | '1Y' | 'All'

function rangeToParams(range: Range): {
  from: string
  to: string
  granularity: 'monthly' | 'daily'
} {
  const today = new Date()
  const to = today.toISOString().slice(0, 10)
  const from = (() => {
    const d = new Date(today)
    if (range === '1M') d.setUTCDate(d.getUTCDate() - 31)
    else if (range === '3M') d.setUTCDate(d.getUTCDate() - 92)
    else if (range === '1Y') d.setUTCDate(d.getUTCDate() - 365)
    else d.setUTCFullYear(d.getUTCFullYear() - 20)
    return d.toISOString().slice(0, 10)
  })()
  const granularity: 'monthly' | 'daily' =
    range === '1M' || range === '3M' ? 'daily' : 'monthly'
  return { from, to, granularity }
}

export function NetWorthPage() {
  const [range, setRange] = useState<Range>('1Y')
  const [editorOpen, setEditorOpen] = useState(false)
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const current = useNetWorthCurrent()
  const seriesParams = useMemo(() => rangeToParams(range), [range])
  const series = useNetWorthSeries(seriesParams)

  async function saveOpening(accountId: number) {
    const raw = drafts[accountId] ?? ''
    const val = Number(raw)
    if (!Number.isFinite(val)) return
    await updateOpeningBalance(accountId, {
      openingBalance: val,
      openingBalanceDate: null,
    })
    current.refresh()
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
    (r): r is typeof r & { accountId: number } => r.source === 'account' && r.accountId != null,
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
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`px-3 py-1 text-sm rounded ${
                range === r ? 'bg-primary text-primary-foreground' : 'border'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </header>

      {cur.partial && (
        <div className="rounded border border-amber-400 bg-amber-50 text-amber-900 p-3 text-sm">
          Some balances couldn’t be converted to CAD. {cur.gaps.length} gap
          {cur.gaps.length === 1 ? '' : 's'}.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded border p-4">
          <div className="text-sm text-muted-foreground">Net worth (CAD)</div>
          <div className="text-3xl font-semibold">{formatMoney(cur.total, 'CAD')}</div>
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
                formatter={(value: number | string) =>
                  formatMoney(typeof value === 'number' ? value : Number(value), 'CAD')
                }
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
            </TableRow>
          </TableHeader>
          <TableBody>
            {accountRows.map((row, i) => (
              <TableRow key={`${row.source}-${row.accountId}-${row.currency}-${i}`}>
                <TableCell>{row.label}</TableCell>
                <TableCell>{row.currency}</TableCell>
                <TableCell className="text-right">
                  {row.native != null ? formatMoney(row.native, row.currency) : '—'}
                </TableCell>
                <TableCell className="text-right">
                  {row.cadValue != null ? formatMoney(row.cadValue, 'CAD') : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="rounded border">
        <button
          type="button"
          onClick={() => setEditorOpen((v) => !v)}
          className="w-full text-left p-4 font-medium"
        >
          Opening balances {editorOpen ? '−' : '+'}
        </button>
        {editorOpen && (
          <div className="p-4 space-y-3 border-t">
            {editableAccounts.length === 0 ? (
              <div className="text-sm text-muted-foreground">No accounts to edit.</div>
            ) : (
              editableAccounts.map((row) => (
                <div
                  key={`${row.accountId}-${row.currency}`}
                  className="flex items-center gap-3"
                >
                  <label className="w-40 truncate" htmlFor={`opening-${row.accountId}`}>
                    {row.label}
                  </label>
                  <input
                    id={`opening-${row.accountId}`}
                    aria-label={`Opening balance for ${row.label}`}
                    type="number"
                    className="border rounded px-2 py-1"
                    onChange={(e) =>
                      setDrafts((d) => ({ ...d, [row.accountId]: e.target.value }))
                    }
                  />
                  <button
                    type="button"
                    onClick={() => saveOpening(row.accountId)}
                    aria-label={`Save ${row.label}`}
                    className="rounded border px-3 py-1 text-sm"
                  >
                    Save
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}
