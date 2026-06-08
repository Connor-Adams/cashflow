/**
 * SearchPage — smart finance search (issue #235).
 *
 * Structured query box that parses tokens like
 *   `category:Groceries amount:>100 date:2026-01-01..2026-03-31 scope:business has:receipt`
 * into a SearchIntent on the backend, then renders chips for each active
 * filter, a result table, and a saved-search dropdown.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Search as SearchIcon, Bookmark, Save, X, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/ui/empty-state'
import { Badge } from '@/components/ui/badge'
import { getJson, postJson, patchJson, deleteReq } from '@/lib/api'
import { formatMoney } from '@/lib/formatMoney'

// Mirrors the backend SearchIntent shape (see backend/src/search/parseSearchQuery.ts).
// Kept loose intentionally — fields populate only when the server parser
// recognises the token. The page never assumes anything is non-null.
export type SearchIntent = {
  merchant?: string
  category?: string
  amount?: { op?: string; value?: number; min?: number; max?: number }
  dateFrom?: string
  dateTo?: string
  hasReceipt?: 'has' | 'none'
  review?: 'yes' | 'no'
  recurring?: 'yes' | 'no'
  scope?: 'business' | 'personal' | 'partner' | 'recurring'
  freeText?: string
  errors: string[]
  isEmpty: boolean
}

type SearchResultRow = {
  id: number
  date: string
  merchantClean: string
  amount: string
  currency: string
  finalCategory: string | null
  finalBusiness: boolean
  isRecurring: boolean
  reviewFlag: boolean
  notes: string | null
}

type SearchResponse = {
  intent: SearchIntent
  results: SearchResultRow[]
  total: number
  limit?: number
  offset?: number
  message?: string
}

type SavedSearch = {
  id: number
  userId: number
  name: string
  query: string
  createdAt: string
  updatedAt: string
}

const EXAMPLES = [
  'category:Groceries amount:>100',
  'merchant:Costco date:2026-01-01..2026-03-31',
  'scope:business has:receipt',
  'review:yes scope:partner',
  'amount:10..50 no:receipt',
]

/**
 * Build human-friendly chip labels from an intent. Skipped filters return
 * the empty string so we can simply filter them out in render.
 */
function buildChips(intent: SearchIntent | null): Array<{ key: string; label: string }> {
  if (!intent) return []
  const chips: Array<{ key: string; label: string }> = []
  if (intent.merchant) chips.push({ key: 'merchant', label: `merchant: ${intent.merchant}` })
  if (intent.category) chips.push({ key: 'category', label: `category: ${intent.category}` })
  if (intent.amount) {
    const a = intent.amount
    if (a.min !== undefined || a.max !== undefined) {
      chips.push({
        key: 'amount',
        label: `amount: ${a.min ?? '0'}..${a.max ?? '∞'}`,
      })
    } else if (a.op !== undefined && a.value !== undefined) {
      chips.push({ key: 'amount', label: `amount: ${a.op}${a.value}` })
    }
  }
  if (intent.dateFrom || intent.dateTo) {
    chips.push({
      key: 'date',
      label: `date: ${intent.dateFrom ?? '…'} to ${intent.dateTo ?? '…'}`,
    })
  }
  if (intent.hasReceipt === 'has') chips.push({ key: 'hasReceipt', label: 'has receipt' })
  if (intent.hasReceipt === 'none') chips.push({ key: 'hasReceipt', label: 'no receipt' })
  if (intent.review === 'yes') chips.push({ key: 'review', label: 'review: yes' })
  if (intent.review === 'no') chips.push({ key: 'review', label: 'review: no' })
  if (intent.recurring === 'yes') chips.push({ key: 'recurring', label: 'recurring: yes' })
  if (intent.recurring === 'no') chips.push({ key: 'recurring', label: 'recurring: no' })
  if (intent.scope) chips.push({ key: 'scope', label: `scope: ${intent.scope}` })
  if (intent.freeText) chips.push({ key: 'freeText', label: `"${intent.freeText}"` })
  return chips
}

export function SearchPage() {
  const [query, setQuery] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [response, setResponse] = useState<SearchResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState<SavedSearch[]>([])
  const [savingName, setSavingName] = useState('')
  const [savingBusy, setSavingBusy] = useState(false)

  const chips = useMemo(() => buildChips(response?.intent ?? null), [response])

  useEffect(() => {
    void refreshSaved()
  }, [])

  async function refreshSaved() {
    try {
      const rows = await getJson<SavedSearch[]>('/api/search/saved')
      setSaved(rows)
    } catch {
      // Non-fatal — the search box still works without saved-search list.
    }
  }

  async function run(q?: string) {
    const text = (q ?? query).trim()
    setSubmitting(true)
    setErr(null)
    try {
      const params = new URLSearchParams()
      params.set('q', text)
      const r = await getJson<SearchResponse>(`/api/search?${params.toString()}`)
      setResponse(r)
    } catch (e) {
      setResponse(null)
      setErr(e instanceof Error ? e.message : 'Search failed')
    } finally {
      setSubmitting(false)
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    void run()
  }

  function applyExample(ex: string) {
    setQuery(ex)
    void run(ex)
  }

  function loadSaved(s: SavedSearch) {
    setQuery(s.query)
    void run(s.query)
  }

  async function saveCurrent(e: FormEvent) {
    e.preventDefault()
    const name = savingName.trim()
    if (!name) return
    if (!query.trim()) return
    setSavingBusy(true)
    setErr(null)
    try {
      await postJson<SavedSearch>('/api/search/saved', {
        name,
        query: query.trim(),
      })
      setSavingName('')
      await refreshSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSavingBusy(false)
    }
  }

  async function renameSaved(s: SavedSearch) {
    const next = window.prompt('Rename saved search', s.name)
    if (next == null) return
    const trimmed = next.trim()
    if (!trimmed || trimmed === s.name) return
    try {
      await patchJson<SavedSearch>(`/api/search/saved/${s.id}`, { name: trimmed })
      await refreshSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Rename failed')
    }
  }

  async function deleteSaved(s: SavedSearch) {
    if (!window.confirm(`Delete saved search "${s.name}"?`)) return
    try {
      await deleteReq(`/api/search/saved/${s.id}`)
      await refreshSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Smart search</h1>
        <p className="muted text-sm">
          Combine filters like{' '}
          <code className="text-xs">category:Groceries amount:&gt;100 has:receipt</code>.
          Free text matches merchant, notes, and category.
        </p>
      </header>

      <form onSubmit={onSubmit} className="flex gap-2">
        <div className="relative flex-1">
          <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='Try "category:Groceries amount:>100 has:receipt"'
            className="pl-9"
            aria-label="Search transactions"
          />
        </div>
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Searching…' : 'Search'}
        </Button>
      </form>

      {saved.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium muted flex items-center gap-2">
            <Bookmark className="h-4 w-4" />
            Saved searches
          </h2>
          <ul className="flex flex-wrap gap-2">
            {saved.map((s) => (
              <li
                key={s.id}
                className="inline-flex items-center gap-1 border border-slate-200 dark:border-slate-700 rounded-md px-2 py-1 text-sm"
              >
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  onClick={() => loadSaved(s)}
                  className="font-medium"
                  title={s.query}
                >
                  {s.name}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Rename ${s.name}`}
                  onClick={() => void renameSaved(s)}
                  className="text-slate-400 hover:text-slate-700"
                >
                  ✎
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Delete ${s.name}`}
                  onClick={() => void deleteSaved(s)}
                  className="text-slate-400 hover:text-red-600"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!response && !err && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium muted">Try one of these</h2>
          <ul className="flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => (
              <li key={ex}>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={() => applyExample(ex)}
                >
                  {ex}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {err && (
        <div
          className="border border-red-300 bg-red-50 dark:bg-red-950 dark:border-red-900 rounded-md p-3 text-sm"
          role="alert"
        >
          {err}
        </div>
      )}

      {response && (
        <section className="space-y-3">
          {chips.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs muted">Active filters:</span>
              {chips.map((c) => (
                <Badge key={c.key} variant="secondary">
                  {c.label}
                </Badge>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setQuery('')
                  setResponse(null)
                }}
                className="text-xs text-slate-500 hover:text-slate-900"
              >
                <X className="h-3 w-3" /> Clear
              </Button>
            </div>
          )}

          {response.intent.errors.length > 0 && (
            <ul className="border border-amber-300 bg-amber-50 dark:bg-amber-950 dark:border-amber-900 rounded-md p-3 text-sm space-y-1">
              {response.intent.errors.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          )}

          {response.intent.isEmpty && response.message && (
            <EmptyState
              title="Type a search to get started"
              description={response.message}
            />
          )}

          {!response.intent.isEmpty && response.results.length === 0 && (
            <EmptyState
              title="No matches"
              description="Try widening your filters or removing the most specific ones."
            />
          )}

          {response.results.length > 0 && (
            <>
              <p className="text-sm muted">
                {response.total} match{response.total === 1 ? '' : 'es'} ·{' '}
                showing {response.results.length}
              </p>
              {query.trim() && (
                <form onSubmit={saveCurrent} className="flex gap-2 items-center">
                  <Input
                    type="text"
                    placeholder="Save current search as…"
                    value={savingName}
                    onChange={(e) => setSavingName(e.target.value)}
                    className="max-w-xs"
                    aria-label="Saved search name"
                  />
                  <Button
                    type="submit"
                    variant="secondary"
                    disabled={savingBusy || !savingName.trim()}
                  >
                    <Save className="h-4 w-4 mr-1" />
                    Save
                  </Button>
                </form>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left">
                    <tr className="border-b border-slate-200 dark:border-slate-700">
                      <th className="py-2 pr-4">Date</th>
                      <th className="py-2 pr-4">Merchant</th>
                      <th className="py-2 pr-4 text-right">Amount</th>
                      <th className="py-2 pr-4">Category</th>
                      <th className="py-2 pr-4">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {response.results.map((r) => (
                      <tr key={r.id} className="border-b border-slate-100 dark:border-slate-800">
                        <td className="py-1 pr-4 whitespace-nowrap">{r.date}</td>
                        <td className="py-1 pr-4">{r.merchantClean}</td>
                        <td className="py-1 pr-4 text-right whitespace-nowrap">
                          {formatMoney(Math.abs(Number(r.amount)), r.currency)}
                        </td>
                        <td className="py-1 pr-4">{r.finalCategory ?? '—'}</td>
                        <td className="py-1 pr-4">{r.notes ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  )
}
