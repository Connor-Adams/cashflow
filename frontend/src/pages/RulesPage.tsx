import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useConfirm } from '@/components/ui/dialog'
import { PageHeader } from '@/components/ui/page-header'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useToast } from '@/components/ui/toast'
import { CategoryCloudPicker } from '../components/CategoryCloudPicker'
import { deleteReq, getJson, postJson } from '../lib/api'
import type { Rule } from '../types/api'

type CategoryHint = {
  label: string
  usageCount: number
}

type RuleAutoSuggestionEvidence = {
  id: number
  date: string
  merchantClean: string
  amount: string
  currency: string
  finalCategory: string | null
  finalBusiness: boolean
  finalSplitType: string
}

type RuleAutoSuggestion = {
  id: string
  merchantPattern: string
  category: string | null
  isBusiness: boolean
  splitType: string
  pctMe: string | null
  pctPartner: string | null
  supportCount: number
  exampleTransactionIds: number[]
  confidence: 'high' | 'medium' | 'low'
  reasoning: string
  evidence: RuleAutoSuggestionEvidence[]
}

const CONFIDENCE_BADGE_CLASS: Record<RuleAutoSuggestion['confidence'], string> = {
  high: 'inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700',
  medium: 'inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700',
  low: 'inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700',
}

export function RulesPage() {
  const [rules, setRules] = useState<Rule[]>([])
  const [searchParams] = useSearchParams()
  const focusedId = (() => {
    const raw = searchParams.get('focus')
    if (raw == null) return null
    const n = Number(raw)
    return Number.isInteger(n) && n > 0 ? n : null
  })()
  const focusedRowRef = useRef<HTMLTableRowElement | null>(null)

  useEffect(() => {
    if (focusedId == null) return
    if (rules.length === 0) return
    focusedRowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [focusedId, rules.length])

  const [suggestions, setSuggestions] = useState<RuleAutoSuggestion[]>([])
  const [categoryHints, setCategoryHints] = useState<CategoryHint[]>([])
  const [ruleCategory, setRuleCategory] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [expandedSuggestionId, setExpandedSuggestionId] = useState<string | null>(
    null
  )
  const loadRequestRef = useRef(0)
  const confirm = useConfirm()
  const { showToast } = useToast()
  const categoryLabels = useMemo(
    () => categoryHints.map((hint) => hint.label),
    [categoryHints]
  )

  async function load() {
    const requestId = ++loadRequestRef.current
    setErr(null)
    try {
      const nextRules = await getJson<Rule[]>('/api/rules')
      const nextSuggestions = await getJson<{ suggestions: RuleAutoSuggestion[] }>(
        '/api/rules/auto-suggestions'
      )
      if (loadRequestRef.current === requestId) {
        setRules(nextRules)
        setSuggestions(nextSuggestions.suggestions)
      }
    } catch (e) {
      if (loadRequestRef.current === requestId) {
        setErr(e instanceof Error ? e.message : 'Error')
      }
    }
  }

  useEffect(() => {
    void load()
  }, [])

  useEffect(() => {
    void getJson<{ categories: CategoryHint[] }>('/api/transactions/category-hints')
      .then((data) => setCategoryHints(data.categories))
      .catch(() => setCategoryHints([]))
  }, [])

  async function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const fd = new FormData(form)
    setErr(null)
    try {
      await postJson('/api/rules', {
        merchantPattern: String(fd.get('merchantPattern') ?? ''),
        matchKind: String(fd.get('matchKind') ?? 'substring'),
        priority: Number(fd.get('priority') ?? 0),
        category: String(fd.get('category') ?? '') || null,
        isBusiness: fd.get('isBusiness') === 'on',
        splitType: String(fd.get('splitType') ?? 'me'),
        pctMe: fd.get('pctMe') ? String(fd.get('pctMe')) : null,
        pctPartner: fd.get('pctPartner') ? String(fd.get('pctPartner')) : null,
      })
      form.reset()
      setRuleCategory('')
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create rule')
    }
  }

  async function remove(rule: Rule) {
    const ok = await confirm({
      title: 'Delete rule?',
      description: `The rule for “${rule.merchantPattern}” will be removed.`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    setErr(null)
    // Snapshot the rule before delete so undo can POST it back. The backend
    // assigns a fresh id on re-create, but pattern/priority/category/etc all
    // round-trip cleanly.
    const snapshot = {
      merchantPattern: rule.merchantPattern,
      matchKind: rule.matchKind,
      priority: rule.priority,
      category: rule.category,
      isBusiness: rule.isBusiness,
      splitType: rule.splitType,
      pctMe: rule.pctMe,
      pctPartner: rule.pctPartner,
    }
    try {
      await deleteReq(`/api/rules/${rule.id}`)
      await load()

      const revert = async () => {
        try {
          await postJson('/api/rules', snapshot)
          await load()
          showToast({ title: 'Rule restored', durationMs: 4000 })
        } catch (revertError) {
          setErr(
            revertError instanceof Error
              ? revertError.message
              : 'Could not restore rule'
          )
        }
      }

      showToast({
        title: `Deleted rule for ${rule.merchantPattern}`,
        variant: 'success',
        durationMs: 10000,
        action: { label: 'Undo', onClick: () => void revert() },
      })
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not delete rule')
    }
  }

  async function acceptSuggestion(suggestion: RuleAutoSuggestion) {
    setErr(null)
    try {
      await postJson(`/api/rules/auto-suggestions/${suggestion.id}/accept`)
      showToast({
        title: `Created rule for ${suggestion.merchantPattern}`,
        variant: 'success',
        durationMs: 4000,
      })
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not accept suggestion')
    }
  }

  async function dismissSuggestion(suggestion: RuleAutoSuggestion) {
    setErr(null)
    try {
      await postJson(`/api/rules/auto-suggestions/${suggestion.id}/dismiss`)
      showToast({
        title: `Dismissed suggestion for ${suggestion.merchantPattern}`,
        durationMs: 4000,
      })
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not dismiss suggestion')
    }
  }

  return (
    <>
    <div className="page">
      <PageHeader
        title="Rules"
        description="Match merchants on import so category, business, and split defaults land in the right place."
      />
      {err && <span className="error">{err}</span>}
      <form className="card rulesFormCard" onSubmit={onCreate}>
        <div className="rulesCardHeader">
          <div>
            <h2>New rule</h2>
            <p className="muted">
              Reuse an existing category when possible to keep reports tidy.
            </p>
          </div>
          <span className="transactionsPanelBadge">
            {categoryLabels.length} categories
          </span>
        </div>
        <div className="formGrid rulesFormGrid">
          <label>
            Pattern
            <input name="merchantPattern" required placeholder="merchant text" />
          </label>
          <label>
            Match
            <select name="matchKind" defaultValue="substring">
              <option value="substring">substring</option>
              <option value="regex">regex</option>
            </select>
          </label>
          <label>
            Priority
            <input name="priority" type="number" defaultValue={0} />
          </label>
          <label className="rulesCategoryField">
            Category
            <CategoryCloudPicker
              className="rulesCategoryPicker"
              cloudClassName="rulesCategoryPickerCloud"
              itemClassName="rulesCategoryPickerItem"
              value={ruleCategory}
              onChange={setRuleCategory}
              options={categoryLabels}
              placeholder="Groceries"
            />
            <input type="hidden" name="category" value={ruleCategory} />
          </label>
          <label className="check">
            <input name="isBusiness" type="checkbox" /> Business
          </label>
          <label>
            Split
            <select name="splitType" defaultValue="me">
              <option value="me">me</option>
              <option value="partner">partner</option>
              <option value="shared">shared</option>
            </select>
          </label>
          <label>
            pct_me (0–1)
            <input name="pctMe" placeholder="0.5" />
          </label>
          <label>
            pct_partner (0–1)
            <input name="pctPartner" placeholder="0.5" />
          </label>
        </div>
        <button type="submit">Add rule</button>
      </form>

      {suggestions.length > 0 && (
        <section className="card rulesTableCard">
          <div className="rulesCardHeader">
            <div>
              <h2>Auto-suggested rules</h2>
              <p className="muted">
                Repeated reviewed merchants we think are stable enough to automate.
                Review the reasoning before accepting.
              </p>
            </div>
            <span className="transactionsPanelBadge">
              {suggestions.length} suggestions
            </span>
          </div>
          <ul className="autoSuggestionList flex flex-col gap-3">
            {suggestions.map((s) => {
              const isExpanded = expandedSuggestionId === s.id
              return (
                <li
                  key={s.id}
                  className="autoSuggestionCard rounded-lg border border-slate-200 bg-white p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{s.merchantPattern}</span>
                        <span className="text-slate-400">→</span>
                        <span className="text-slate-700">
                          {s.category ?? 'uncategorized'}
                        </span>
                        {s.isBusiness && (
                          <span className="inline-flex items-center rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700">
                            business
                          </span>
                        )}
                        {s.splitType !== 'me' && (
                          <span className="inline-flex items-center rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700">
                            split: {s.splitType}
                          </span>
                        )}
                        <span className={CONFIDENCE_BADGE_CLASS[s.confidence]}>
                          {s.confidence} confidence
                        </span>
                        <span className="text-xs text-slate-500">
                          {s.supportCount} reviewed
                        </span>
                      </div>
                      <p className="muted mt-2 text-sm">{s.reasoning}</p>
                    </div>
                    <div className="autoSuggestionActions flex gap-2">
                      <button
                        type="button"
                        onClick={() => void acceptSuggestion(s)}
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        onClick={() => void dismissSuggestion(s)}
                      >
                        Dismiss
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedSuggestionId((cur) =>
                            cur === s.id ? null : s.id
                          )
                        }
                        aria-expanded={isExpanded}
                      >
                        {isExpanded ? 'Hide evidence' : 'Show evidence'}
                      </button>
                    </div>
                  </div>
                  {isExpanded && s.evidence.length > 0 && (
                    <div className="autoSuggestionEvidence mt-3 rounded-md bg-slate-50 p-3">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Evidence ({s.evidence.length}
                        {s.evidence.length < s.supportCount
                          ? ` of ${s.supportCount}`
                          : ''}
                        )
                      </h3>
                      <ul className="mt-2 flex flex-col gap-1 text-sm">
                        {s.evidence.map((ev) => (
                          <li
                            key={ev.id}
                            className="flex flex-wrap items-center gap-2 text-slate-600"
                          >
                            <span className="font-mono text-xs text-slate-500">
                              #{ev.id}
                            </span>
                            <span>{ev.date}</span>
                            <span className="text-slate-400">·</span>
                            <span>{ev.merchantClean}</span>
                            <span className="text-slate-400">·</span>
                            <span>
                              {ev.amount} {ev.currency}
                            </span>
                            <span className="text-slate-400">·</span>
                            <span>{ev.finalCategory ?? 'uncategorized'}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      <section className="card rulesTableCard">
        <div className="rulesCardHeader">
          <div>
            <h2>Existing rules</h2>
            <p className="muted">
              Higher priority wins when several patterns match the same transaction.
            </p>
          </div>
          <span className="transactionsPanelBadge">{rules.length} rules</span>
        </div>
        <div className="tableWrap">
          <Table className="table">
            <TableHeader>
              <TableRow>
                <TableHead>Pattern</TableHead>
                <TableHead>Match</TableHead>
                <TableHead>Pri</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Biz</TableHead>
                <TableHead>Split</TableHead>
                <TableHead>Usage</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="emptyStateCell">
                    <p>No rules yet. Add a pattern above to start automating imports.</p>
                    <p className="muted">
                      Rules set default category, business flag, and split for matching merchants on import.
                    </p>
                  </TableCell>
                </TableRow>
              ) : (
                rules.map((r) => (
                  <TableRow
                    key={r.id}
                    ref={r.id === focusedId ? focusedRowRef : undefined}
                    className={r.id === focusedId ? 'ruleRow isFocused' : 'ruleRow'}
                  >
                    <TableCell>{r.merchantPattern}</TableCell>
                    <TableCell>{r.matchKind}</TableCell>
                    <TableCell>{r.priority}</TableCell>
                    <TableCell>{r.category ?? '—'}</TableCell>
                    <TableCell>{r.isBusiness ? 'yes' : ''}</TableCell>
                    <TableCell>{r.splitType}</TableCell>
                    <TableCell>{r.usageCount ?? 0}</TableCell>
                    <TableCell>
                      <button type="button" onClick={() => void remove(r)}>
                        Delete
                      </button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
    {confirm.dialog}
    </>
  )
}
