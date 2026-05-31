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
import { RulesHealthSection } from '../components/RulesHealthSection'
import { deleteReq, getJson, postJson } from '../lib/api'
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

  const [proposals, setProposals] = useState<RuleProposal[]>([])
  const [autoSuggestions, setAutoSuggestions] = useState<AutoRuleSuggestion[]>([])
  const [categoryHints, setCategoryHints] = useState<CategoryHint[]>([])
  const [ruleCategory, setRuleCategory] = useState('')
  const [ruleSplitType, setRuleSplitType] = useState('me')
  const [rulePctMe, setRulePctMe] = useState('')
  const [rulePctPartner, setRulePctPartner] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [importMode, setImportMode] = useState<'append' | 'replace'>('append')
  const [importing, setImporting] = useState(false)
  const importFileRef = useRef<HTMLInputElement | null>(null)
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
      } catch {
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
      const pctMeNum = rulePctMe.trim() ? Number(rulePctMe) / 100 : null;
      const pctPartnerNum = rulePctPartner.trim() ? Number(rulePctPartner) / 100 : null;
      if (ruleSplitType === 'shared' && pctMeNum !== null && pctPartnerNum !== null) {
        const sum = pctMeNum + pctPartnerNum;
        if (Math.abs(sum - 1) > 0.001) {
          setErr(`Shares must add to 100% (current: ${Math.round(sum * 100)}%)`)
          return;
        }
      }
      await postJson('/api/rules', {
        merchantPattern: String(fd.get('merchantPattern') ?? ''),
        matchKind: String(fd.get('matchKind') ?? 'substring'),
        priority: Number(fd.get('priority') ?? 0),
        category: String(fd.get('category') ?? '') || null,
        isBusiness: fd.get('isBusiness') === 'on',
        splitType: ruleSplitType,
        pctMe: pctMeNum !== null ? String(pctMeNum) : null,
        pctPartner: pctPartnerNum !== null ? String(pctPartnerNum) : null,
      })
      form.reset()
      setRuleCategory('')
      setRuleSplitType('me')
      setRulePctMe('')
      setRulePctPartner('')
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

  async function importRules() {
    const file = importFileRef.current?.files?.[0]
    if (!file) {
      showToast({ title: 'Choose a JSON file first.', variant: 'destructive' })
      return
    }
    if (importMode === 'replace') {
      const ok = await confirm({
        title: 'Replace all rules?',
        description: 'This will permanently delete all existing rules and replace them with the imported ones. This cannot be undone.',
        confirmLabel: 'Replace',
        cancelLabel: 'Cancel',
        destructive: true,
      })
      if (!ok) return
    }
    setImporting(true)
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as { rules?: unknown[] }
      const rules = parsed.rules ?? (Array.isArray(parsed) ? parsed : [])
      const result = await postJson<{ imported: number; mode: string }>(
        '/api/rules/import',
        { rules, mode: importMode },
      )
      if (importFileRef.current) importFileRef.current.value = ''
      await load()
      showToast({
        title: `Imported ${result.imported} rule${result.imported === 1 ? '' : 's'} (${importMode} mode)`,
        variant: 'success',
      })
    } catch (e) {
      showToast({
        title: e instanceof Error ? e.message : 'Import failed',
        variant: 'destructive',
      })
    } finally {
      setImporting(false)
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
            <input name="merchantPattern" required placeholder="merchant text" />
          </label>
          <label>
            Match type
            <select name="matchKind" defaultValue="substring">
              <option value="substring">Contains (plain text)</option>
              <option value="regex">Regex (advanced)</option>
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
            <select
              name="splitType"
              value={ruleSplitType}
              onChange={(e) => setRuleSplitType(e.target.value)}
            >
              <option value="me">Mine</option>
              <option value="partner">Partner's</option>
              <option value="shared">Shared</option>
            </select>
          </label>
          {ruleSplitType === 'shared' && (
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
                  value={rulePctMe}
                  onChange={(e) => setRulePctMe(e.target.value)}
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
                  value={rulePctPartner}
                  onChange={(e) => setRulePctPartner(e.target.value)}
                />
              </label>
              {(() => {
                const me = Number(rulePctMe) || 0;
                const partner = Number(rulePctPartner) || 0;
                const sum = me + partner;
                return rulePctMe && rulePctPartner && Math.abs(sum - 100) > 0.1 ? (
                  <p style={{ color: 'var(--color-destructive)', fontSize: '0.8rem', gridColumn: '1 / -1' }}>
                    Shares must add to 100% (current: {sum}%)
                  </p>
                ) : (
                  <p style={{ color: 'var(--color-muted-foreground)', fontSize: '0.8rem', gridColumn: '1 / -1' }}>
                    Must sum to 100%
                  </p>
                );
              })()}
            </>
          )}
        </div>
        <button type="submit">Add rule</button>
      </form>

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

      <section className="card">
        <div className="rulesCardHeader">
          <div>
            <h2>Export / Import</h2>
            <p className="muted">Back up your rules or share them with a co-user.</p>
          </div>
        </div>
        <div className="formGrid" style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <a
              href="/api/rules/export"
              download
              className="inline-flex items-center rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-accent"
            >
              Download rules JSON
            </a>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              ref={importFileRef}
              type="file"
              accept=".json,application/json"
              className="text-sm"
            />
            <select
              value={importMode}
              onChange={(e) => setImportMode(e.target.value as 'append' | 'replace')}
              className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            >
              <option value="append">Append (merge with existing)</option>
              <option value="replace">Replace (delete all, then import)</option>
            </select>
            <button
              type="button"
              onClick={() => void importRules()}
              disabled={importing}
              className="inline-flex items-center rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-accent disabled:opacity-50"
            >
              {importing ? 'Importing…' : 'Import rules'}
            </button>
          </div>
        </div>
      </section>

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
