import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/ui/empty-state'
import { Badge } from '@/components/ui/badge'
import { useAiStatus } from '@/hooks/useAiStatus'
import { postJson } from '@/lib/api'
import { formatMoney } from '@/lib/formatMoney'

type SourceTxn = {
  id: number
  date: string
  merchant: string
  amount: number
  currency: string
  category: string | null
}

type QueryGroup = { key: string; count: number; total: number }
type ComparisonDetail = {
  periodA: { label: string; total: number; count: number }
  periodB: { label: string; total: number; count: number }
  delta: number
  pctChange: number | null
}
type PartnerBalance = {
  contactName: string
  currency: string
  netBalance: number
  direction: 'partner_owes_me' | 'i_owe_partner' | 'settled'
}
type SubIncrease = {
  merchant: string
  currency: string
  earlierAvg: number
  laterAvg: number
  pctChange: number
  occurrencesEarlier: number
  occurrencesLater: number
}

type QueryAnswer = {
  headline: string
  totalsByCurrency: Array<{ currency: string; total: number; count: number }>
  groups?: QueryGroup[]
  comparison?: ComparisonDetail
  subscriptionsIncreased?: SubIncrease[]
  partnerBalances?: PartnerBalance[]
}

type QueryResponse = {
  question: string
  intent: { intent: string; [k: string]: unknown }
  answer: QueryAnswer
  sources: SourceTxn[]
  meta: { model: string; promptVersion: string; latencyMs: number }
}

const EXAMPLES = [
  'How much did I spend on Restaurants last month?',
  'Show business expenses missing receipts this year.',
  'Compare groceries this month vs last month.',
  'What subscriptions increased in the last 6 months?',
  'How much does my partner owe me?',
]

export function AskCashflowPage() {
  const aiStatus = useAiStatus()
  const [question, setQuestion] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<QueryResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const aiUnavailable = aiStatus?.openai === false

  async function run(qOverride?: string) {
    const q = (qOverride ?? question).trim()
    if (!q) return
    setSubmitting(true)
    setErr(null)
    try {
      const r = await postJson<QueryResponse>('/api/ai/query', { question: q })
      setResult(r)
    } catch (e) {
      setResult(null)
      setErr(e instanceof Error ? e.message : 'Query failed')
    } finally {
      setSubmitting(false)
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    void run()
  }

  function onExampleClick(example: string) {
    setQuestion(example)
    void run(example)
  }

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-4">
      <header>
        <h1 className="mb-1 text-2xl font-semibold">Ask Cashflow</h1>
        <p className="muted">
          Type a financial question in plain English. We translate it to a safe
          query — the model never writes SQL.
        </p>
      </header>

      <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row">
        <Input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask Cashflow…"
          aria-label="Ask Cashflow"
          maxLength={500}
          disabled={submitting || aiUnavailable}
        />
        <Button type="submit" disabled={submitting || aiUnavailable || !question.trim()}>
          {submitting ? 'Thinking…' : 'Ask'}
        </Button>
      </form>

      {aiUnavailable ? (
        <EmptyState
          title="AI features are not configured"
          description="Set OPENAI_API_KEY on the backend to enable natural-language queries."
        />
      ) : null}

      {!result && !err && !aiUnavailable ? (
        <section aria-label="Example questions">
          <p className="muted mb-2 text-sm">Try one of these:</p>
          <ul className="flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => (
              <li key={ex}>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => onExampleClick(ex)}
                >
                  {ex}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {err ? <p className="error" role="alert">{err}</p> : null}

      {result ? <QueryResultView result={result} /> : null}
    </main>
  )
}

function QueryResultView({ result }: { result: QueryResponse }) {
  return (
    <section
      aria-label="Query result"
      className="rounded-lg border border-border bg-muted/10 p-4"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge variant="outline">{result.intent.intent}</Badge>
        <span className="muted text-xs">{result.meta.model}</span>
      </div>
      <p className="mb-3 text-base font-medium">{result.answer.headline}</p>

      {result.answer.totalsByCurrency.length > 0 ? (
        <TotalsTable totals={result.answer.totalsByCurrency} />
      ) : null}

      {result.answer.comparison ? (
        <ComparisonView c={result.answer.comparison} />
      ) : null}

      {result.answer.groups && result.answer.groups.length > 0 ? (
        <GroupsTable groups={result.answer.groups} />
      ) : null}

      {result.answer.subscriptionsIncreased && result.answer.subscriptionsIncreased.length > 0 ? (
        <SubscriptionsTable rows={result.answer.subscriptionsIncreased} />
      ) : null}

      {result.answer.partnerBalances && result.answer.partnerBalances.length > 0 ? (
        <PartnerBalancesTable rows={result.answer.partnerBalances} />
      ) : null}

      <SourceTransactionsList sources={result.sources} />
    </section>
  )
}

function TotalsTable({
  totals,
}: {
  totals: Array<{ currency: string; total: number; count: number }>
}) {
  return (
    <div className="mb-3">
      <h2 className="mb-1 text-sm font-semibold">Totals</h2>
      <ul className="flex flex-wrap gap-3">
        {totals.map((t) => (
          <li
            key={t.currency}
            className="rounded-md border border-border bg-background/60 px-3 py-2"
          >
            <div className="text-lg font-medium">{formatMoney(t.total, t.currency)}</div>
            <div className="muted text-xs">{t.count} transaction{t.count === 1 ? '' : 's'}</div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ComparisonView({ c }: { c: ComparisonDetail }) {
  return (
    <div className="mb-3">
      <h2 className="mb-1 text-sm font-semibold">Comparison</h2>
      <div className="flex flex-wrap gap-3">
        <PeriodCard label={c.periodA.label} total={c.periodA.total} count={c.periodA.count} />
        <PeriodCard label={c.periodB.label} total={c.periodB.total} count={c.periodB.count} />
      </div>
      <p className="mt-2 text-sm">
        Delta: <strong>{c.delta >= 0 ? '+' : ''}{c.delta.toFixed(2)}</strong>
        {c.pctChange != null ? (
          <span className="muted">
            {' '}({c.pctChange >= 0 ? '+' : ''}
            {c.pctChange.toFixed(1)}%)
          </span>
        ) : null}
      </p>
    </div>
  )
}

function PeriodCard({ label, total, count }: { label: string; total: number; count: number }) {
  return (
    <div className="rounded-md border border-border bg-background/60 px-3 py-2">
      <div className="muted text-xs">{label}</div>
      <div className="text-base font-medium">{total.toFixed(2)}</div>
      <div className="muted text-xs">{count} transaction{count === 1 ? '' : 's'}</div>
    </div>
  )
}

function GroupsTable({ groups }: { groups: QueryGroup[] }) {
  return (
    <div className="mb-3">
      <h2 className="mb-1 text-sm font-semibold">Breakdown</h2>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left muted">
            <th className="pr-2">Group</th>
            <th className="pr-2 text-right">Total</th>
            <th className="text-right">Count</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.key} className="border-t border-border/60">
              <td className="py-1 pr-2">{g.key}</td>
              <td className="py-1 pr-2 text-right">{g.total.toFixed(2)}</td>
              <td className="py-1 text-right">{g.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SubscriptionsTable({ rows }: { rows: SubIncrease[] }) {
  return (
    <div className="mb-3">
      <h2 className="mb-1 text-sm font-semibold">Subscriptions with price increases</h2>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left muted">
            <th className="pr-2">Merchant</th>
            <th className="pr-2 text-right">Earlier avg</th>
            <th className="pr-2 text-right">Later avg</th>
            <th className="text-right">% change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.merchant}-${r.currency}`} className="border-t border-border/60">
              <td className="py-1 pr-2">{r.merchant}</td>
              <td className="py-1 pr-2 text-right">{r.earlierAvg.toFixed(2)} {r.currency}</td>
              <td className="py-1 pr-2 text-right">{r.laterAvg.toFixed(2)} {r.currency}</td>
              <td className="py-1 text-right">+{r.pctChange.toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PartnerBalancesTable({ rows }: { rows: PartnerBalance[] }) {
  return (
    <div className="mb-3">
      <h2 className="mb-1 text-sm font-semibold">Partner balances</h2>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left muted">
            <th className="pr-2">Contact</th>
            <th className="pr-2 text-right">Net balance</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.contactName}-${r.currency}`} className="border-t border-border/60">
              <td className="py-1 pr-2">{r.contactName}</td>
              <td className="py-1 pr-2 text-right">
                {r.netBalance.toFixed(2)} {r.currency}
              </td>
              <td className="py-1">
                {r.direction === 'settled'
                  ? 'Settled'
                  : r.direction === 'partner_owes_me'
                  ? 'Partner owes you'
                  : 'You owe partner'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SourceTransactionsList({ sources }: { sources: SourceTxn[] }) {
  if (!sources.length) return null
  const ids = sources.map((s) => s.id).join(',')
  return (
    <div>
      <h2 className="mb-1 mt-3 text-sm font-semibold">
        Source transactions{' '}
        <Link to={`/transactions?ids=${ids}`} className="muted text-xs">
          (open in Transactions)
        </Link>
      </h2>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left muted">
            <th className="pr-2">Date</th>
            <th className="pr-2">Merchant</th>
            <th className="pr-2">Category</th>
            <th className="text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((s) => (
            <tr key={s.id} className="border-t border-border/60">
              <td className="py-1 pr-2">{s.date}</td>
              <td className="py-1 pr-2">
                <Link to={`/transactions?ids=${s.id}`}>{s.merchant}</Link>
              </td>
              <td className="py-1 pr-2 muted">{s.category ?? 'Uncategorized'}</td>
              <td className="py-1 text-right">{formatMoney(s.amount, s.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
