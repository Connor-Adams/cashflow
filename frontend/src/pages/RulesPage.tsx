import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useConfirm } from '@/components/ui/dialog'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { SortableTableHead } from '@/components/ui/sortable-table-head'
import { useUrlSort } from '@/hooks/useUrlSort'
import { useToast } from '@/components/ui/toast'
import { CategoryCloudPicker } from '../components/CategoryCloudPicker'
import { RulesHealthSection } from '../components/RulesHealthSection'
import { deleteReq, getJson, postJson } from '../lib/api'
import { ImportRulesModal } from '@/components/rules/ImportRulesModal'
import { RulePatternPreview } from '@/components/rules/RulePatternPreview'
import type { Rule } from '../types/api'

type CategoryHint = {
  label: string
  usageCount: number
}

type RuleProposal = {
  merchantPattern: string
  category: string | null
  isBusiness: boolean
  splitType: string
  pctMe: string | null
  pctPartner: string | null
  supportCount: number
  exampleTransactionIds: number[]
}

type AutoRuleSuggestion = RuleProposal & {
  id: string
  confidence: number
  reasoning: string
}

type RulesSortField = 'name' | 'matchType' | 'priority' | 'updatedAt'

export function RulesPage() {
  const [rules, setRules] = useState<Rule[]>([])
  const [searchParams] = useSearchParams()
  const { sort: rulesSort, dir: rulesDir, setSort: setRulesSort } = useUrlSort<RulesSortField>()
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

  const [proposals, setProposals] = useState<RuleProposal[]>([])
  const [autoSuggestions, setAutoSuggestions] = useState<AutoRuleSuggestion[]>([])
  const [suggestionsUnavailable, setSuggestionsUnavailable] = useState(false)
  const [categoryHints, setCategoryHints] = useState<CategoryHint[]>([])
  const [ruleCategory, setRuleCategory] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const loadRequestRef = useRef(0)
  const [importModalOpen, setImportModalOpen] = useState(false)
  const confirm = useConfirm()
  const { showToast } = useToast()
  // Controlled form state for validation
  const [formPattern, setFormPattern] = useState('')
  const [formMatchKind, setFormMatchKind] = useState('substring')
  const [formSplitType, setFormSplitType] = useState('me')
  const [formPctMe, setFormPctMe] = useState('')
  const [formPctPartner, setFormPctPartner] = useState('')
  const pctSum = (Number(formPctMe) || 0) + (Number(formPctPartner) || 0)
  const shareError =
    formSplitType === 'shared' && (formPctMe || formPctPartner) && pctSum !== 100
      ? `Shares must add to 100% (current: ${pctSum}%)`
      : null
  const categoryLabels = useMemo(
    () => categoryHints.map((hint) => hint.label),
    [categoryHints]
  )

  async function load() {
    const requestId = ++loadRequestRef.current
    setErr(null)
    try {
      const rulesQs = rulesSort ? `?sort=${rulesSort}&dir=${rulesDir}` : ''
      const nextRules = await getJson<Rule[]>(`/api/rules${rulesQs}`)
      const nextProposals = await getJson<{ proposals: RuleProposal[] }>(
        '/api/ai/rule-proposals'
      )
      // Auto-rule suggestions endpoint may not exist on older backends; fall
      // back to an empty list if it 404s instead of breaking the whole page.
      // Also defend against a 200 with a malformed body (e.g. `{}` from a
      // test stub) by coalescing missing/undefined `suggestions` to [].
      let nextAuto: AutoRuleSuggestion[] = []
      try {
        const r = await getJson<{ suggestions?: AutoRuleSuggestion[] }>(
          '/api/rules/auto-suggestions'
        )
        nextAuto = r.suggestions ?? []
      } catch (err) {
        console.warn('[RulesPage] auto-suggestions endpoint failed:', err)
        setSuggestionsUnavailable(true)
        nextAuto = []
      }
      if (loadRequestRef.current === requestId) {
        setRules(nextRules)
        setProposals(nextProposals.proposals)
        setAutoSuggestions(nextAuto)
      }
    } catch (e) {
      if (loadRequestRef.current === requestId) {
        setErr(e instanceof Error ? e.message : 'Error')
      }
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rulesSort, rulesDir])

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
      const rawPctMe = fd.get('pctMe') ? Number(fd.get('pctMe')) : null
      const rawPctPartner = fd.get('pctPartner') ? Number(fd.get('pctPartner')) : null
      await postJson('/api/rules', {
        merchantPattern: String(fd.get('merchantPattern') ?? ''),
        matchKind: String(fd.get('matchKind') ?? 'substring'),
        priority: Number(fd.get('priority') ?? 0),
        category: String(fd.get('category') ?? '') || null,
        isBusiness: fd.get('isBusiness') === 'on',
        splitType: String(fd.get('splitType') ?? 'me'),
        pctMe: rawPctMe != null && !Number.isNaN(rawPctMe) ? String(rawPctMe / 100) : null,
        pctPartner: rawPctPartner != null && !Number.isNaN(rawPctPartner) ? String(rawPctPartner / 100) : null,
      })
      form.reset()
      setRuleCategory('')
      setFormPattern('')
      setFormMatchKind('substring')
      setFormSplitType('me')
      setFormPctMe('')
      setFormPctPartner('')
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

  async function approveProposal(proposal: RuleProposal) {
    setErr(null)
    try {
      await postJson(
        `/api/ai/rule-proposals/${encodeURIComponent(proposal.merchantPattern)}/approve`,
        proposal
      )
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not approve proposal')
    }
  }

  async function acceptAutoSuggestion(suggestion: AutoRuleSuggestion) {
    setErr(null)
    try {
      await postJson(
        `/api/rules/auto-suggestions/${encodeURIComponent(suggestion.id)}/accept`
      )
      await load()
      showToast({
        title: `Created rule for ${suggestion.merchantPattern}`,
        variant: 'success',
        durationMs: 4000,
      })
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not accept suggestion')
    }
  }

  async function dismissAutoSuggestion(suggestion: AutoRuleSuggestion) {
    setErr(null)
    try {
      await postJson(
        `/api/rules/auto-suggestions/${encodeURIComponent(suggestion.id)}/dismiss`
      )
      await load()
      showToast({
        title: `Dismissed ${suggestion.merchantPattern}`,
        durationMs: 4000,
      })
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not dismiss suggestion')
    }
  }

  async function handleExport() {
    try {
      const base = import.meta.env.VITE_API_BASE ?? ''
      const res = await fetch(`${base}/api/rules/export`, { credentials: 'include' })
      if (!res.ok) { showToast({ title: 'Export failed', variant: 'destructive' }); return; }
      const blob = await res.blob()
      const cd = res.headers.get('content-disposition') ?? ''
      const match = cd.match(/filename="([^"]+)"/)
      const filename = match?.[1] ?? 'cashflow-rules.json'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      showToast({ title: 'Export failed', variant: 'destructive' })
    }
  }

  return (
    <>
    <div className="page">
      <PageHeader
        title="Rules"
        description="Match merchants on import so category, business, and split defaults land in the right place."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void handleExport()}>Export rules</Button>
            <Button variant="outline" size="sm" onClick={() => setImportModalOpen(true)}>Import rules</Button>
          </div>
        }
      />
      {err && <span className="error">{err}</span>}
      <RulesHealthSection onAfterCreate={() => void load()} />
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
            <input
              name="merchantPattern"
              required
              placeholder="merchant text"
              value={formPattern}
              onChange={(e) => setFormPattern(e.target.value)}
            />
            <RulePatternPreview pattern={formPattern} matchType={formMatchKind} />
          </label>
          <label>
            Match type
            <select
              name="matchKind"
              value={formMatchKind}
              onChange={(e) => setFormMatchKind(e.target.value)}
            >
              <option value="substring">substring</option>
              <option value="regex">regex</option>
            </select>
            <span className="muted" style={{ fontSize: '0.75rem' }}>
              substring matches any part of the description; regex is for patterns (advanced).
            </span>
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
            <select
              name="splitType"
              value={formSplitType}
              onChange={(e) => setFormSplitType(e.target.value)}
            >
              <option value="me">me</option>
              <option value="partner">partner</option>
              <option value="shared">shared</option>
            </select>
          </label>
          {formSplitType === 'shared' && (
            <>
              <label>
                Your share (%)
                <input
                  name="pctMe"
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  placeholder="50"
                  value={formPctMe}
                  onChange={(e) => setFormPctMe(e.target.value)}
                />
              </label>
              <label>
                Partner's share (%)
                <input
                  name="pctPartner"
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  placeholder="50"
                  value={formPctPartner}
                  onChange={(e) => setFormPctPartner(e.target.value)}
                />
              </label>
              <div style={{ gridColumn: '1 / -1' }}>
                <span className="muted" style={{ fontSize: '0.75rem' }}>Must sum to 100%</span>
                {shareError && (
                  <p className="text-sm" style={{ color: 'var(--color-red-600, #dc2626)', marginTop: '0.25rem' }}>
                    {shareError}
                  </p>
                )}
              </div>
            </>
          )}
        </div>
        <button type="submit" disabled={!!shareError}>Add rule</button>
      </form>

      {suggestionsUnavailable && (
        <p className="muted text-sm">Auto-rule suggestions are temporarily unavailable.</p>
      )}
      {autoSuggestions.length > 0 && (
        <section className="card rulesTableCard">
          <div className="rulesCardHeader">
            <div>
              <h2>Auto-rule suggestions</h2>
              <p className="muted">
                Patterns we spotted in your recent reviews. Accept to create a
                rule; dismiss to hide the suggestion.
              </p>
            </div>
            <span className="transactionsPanelBadge">
              {autoSuggestions.length} suggestion{autoSuggestions.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="tableWrap">
            <Table className="table">
              <TableHeader>
                <TableRow>
                  <TableHead>Pattern</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Biz</TableHead>
                  <TableHead>Split</TableHead>
                  <TableHead>Confidence</TableHead>
                  <TableHead>Why</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {autoSuggestions.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>{s.merchantPattern}</TableCell>
                    <TableCell>{s.category ?? '—'}</TableCell>
                    <TableCell>{s.isBusiness ? 'yes' : ''}</TableCell>
                    <TableCell>{s.splitType}</TableCell>
                    <TableCell>
                      <span className="transactionsPanelBadge">
                        {Math.round(s.confidence * 100)}%
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="muted">{s.reasoning}</span>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => void acceptAutoSuggestion(s)}
                        >
                          Accept
                        </button>
                        <button
                          type="button"
                          onClick={() => void dismissAutoSuggestion(s)}
                        >
                          Dismiss
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      {proposals.length > 0 && (
        <section className="card rulesTableCard">
          <div className="rulesCardHeader">
            <div>
              <h2>AI rule proposals</h2>
              <p className="muted">
                Repeated reviewed merchants that look stable enough to automate.
              </p>
            </div>
            <span className="transactionsPanelBadge">{proposals.length} proposals</span>
          </div>
          <div className="tableWrap">
            <Table className="table">
              <TableHeader>
                <TableRow>
                  <TableHead>Pattern</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Biz</TableHead>
                  <TableHead>Split</TableHead>
                  <TableHead>Support</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {proposals.map((p) => (
                  <TableRow key={`${p.merchantPattern}-${p.category}-${p.splitType}`}>
                    <TableCell>{p.merchantPattern}</TableCell>
                    <TableCell>{p.category ?? '—'}</TableCell>
                    <TableCell>{p.isBusiness ? 'yes' : ''}</TableCell>
                    <TableCell>{p.splitType}</TableCell>
                    <TableCell>
                      {p.supportCount} rows #{p.exampleTransactionIds.join(', #')}
                    </TableCell>
                    <TableCell>
                      <button type="button" onClick={() => void approveProposal(p)}>
                        Approve
                      </button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
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
                <SortableTableHead field="name" currentSort={rulesSort} dir={rulesDir} onSort={setRulesSort}>Pattern</SortableTableHead>
                <SortableTableHead field="matchType" currentSort={rulesSort} dir={rulesDir} onSort={setRulesSort}>Match</SortableTableHead>
                <SortableTableHead field="priority" currentSort={rulesSort} dir={rulesDir} onSort={setRulesSort}>Pri</SortableTableHead>
                <SortableTableHead field="updatedAt" currentSort={rulesSort} dir={rulesDir} onSort={setRulesSort}>Updated</SortableTableHead>
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
    {importModalOpen && (
      <ImportRulesModal
        onClose={() => setImportModalOpen(false)}
        onImported={() => { void load(); setImportModalOpen(false); }}
      />
    )}
    </>
  )
}
