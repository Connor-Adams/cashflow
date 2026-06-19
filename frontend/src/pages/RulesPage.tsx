import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { useConfirm } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { EmptyTableRow } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { SectionHeader } from '@/components/ui/section-header'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { SortableTableHead } from '@/components/table/SortableTableHead'
import { useToast } from '@/components/ui/toast'
import { CategoryCloudPicker } from '../components/CategoryCloudPicker'
import { RulesHealthSection } from '../components/RulesHealthSection'
import { ImportRulesModal } from '../components/rules/ImportRulesModal'
import { deleteReq, getJson, postJson } from '../lib/api'
import { useUrlSort } from '../hooks/useUrlSort'
import { useLabels } from '../lib/useLabels'
import type { Rule, RuleAction } from '../types/api'

type AlertSeverity = 'info' | 'warn' | 'critical'

const RULES_SORT_FIELDS = ['name', 'matchType', 'priority', 'updatedAt'] as const

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
  const { sort: rulesSort, dir: rulesDir, toggle: toggleRulesSort } = useUrlSort(RULES_SORT_FIELDS)
  const rulesSortRef = useRef({ sort: rulesSort, dir: rulesDir })
  rulesSortRef.current = { sort: rulesSort, dir: rulesDir }

  useEffect(() => {
    if (focusedId == null) return
    if (rules.length === 0) return
    focusedRowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [focusedId, rules.length])

  const [proposals, setProposals] = useState<RuleProposal[]>([])
  const [autoSuggestions, setAutoSuggestions] = useState<AutoRuleSuggestion[]>([])
  const [categoryHints, setCategoryHints] = useState<CategoryHint[]>([])
  const [ruleCategory, setRuleCategory] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [importModalOpen, setImportModalOpen] = useState(false)
  const [exportLoading, setExportLoading] = useState(false)
  const loadRequestRef = useRef(0)
  const confirm = useConfirm()
  const { showToast } = useToast()
  const categoryLabels = useMemo(
    () => categoryHints.map((hint) => hint.label),
    [categoryHints]
  )

  // Controlled state for the new-rule form to enable inline validation.
  const [newPattern, setNewPattern] = useState('')
  const [newMatchKind, setNewMatchKind] = useState('substring')
  const [newSplitType, setNewSplitType] = useState('me')
  const [newPctMe, setNewPctMe] = useState('')
  const [newPctPartner, setNewPctPartner] = useState('')
  const [shareError, setShareError] = useState<string | null>(null)
  const [patternError, setPatternError] = useState<string | null>(null)
  // Issue #795 — composable action rows on the create form.
  const { labels, loading: labelsLoading } = useLabels()
  const [newLabelIds, setNewLabelIds] = useState<number[]>([])
  const [alertEnabled, setAlertEnabled] = useState(false)
  const [alertSeverity, setAlertSeverity] = useState<AlertSeverity>('info')
  const [alertTitle, setAlertTitle] = useState('')
  const [alertBody, setAlertBody] = useState('')
  // A set_label row referencing a label that no longer exists must block save
  // and surface a warning (AC #9, editor side).
  const danglingLabelIds = useMemo(
    () => newLabelIds.filter((id) => !labels.some((l) => l.id === id)),
    [newLabelIds, labels],
  )
  const [previewState, setPreviewState] = useState<
    null | 'counting' | { matches: number } | { error: string }
  >(null)
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const validateShares = useCallback((pctMe: string, pctPartner: string, splitType: string) => {
    if (splitType !== 'shared') { setShareError(null); return true; }
    const me = parseFloat(pctMe)
    const partner = parseFloat(pctPartner)
    // Range-check each provided side on its own: a single filled field is
    // valid (the backend gives the other side the remainder), but it must
    // still be a real percentage.
    for (const [label, v] of [['Your share', me], ["Partner's share", partner]] as const) {
      if (!isNaN(v) && (v < 0 || v > 100)) {
        setShareError(`${label} must be between 0 and 100%`)
        return false
      }
    }
    if (!isNaN(me) && !isNaN(partner)) {
      const sum = Math.round((me + partner) * 10) / 10
      if (Math.abs(sum - 100) > 0.05) {
        setShareError(`Shares must add to 100% (current: ${sum}%)`)
        return false
      }
    }
    setShareError(null)
    return true
  }, [])

  const fetchPreview = useCallback(async (pattern: string, matchKind: string) => {
    if (!pattern) { setPreviewState(null); return; }
    setPreviewState('counting')
    try {
      const result = await postJson<{ matches: number }>('/api/rules/preview-pattern', {
        pattern,
        matchType: matchKind,
      })
      setPreviewState({ matches: result.matches })
      setPatternError(null)
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Invalid pattern'
      setPreviewState({ error: message })
      if (matchKind === 'regex') setPatternError(`Invalid pattern: ${message}`)
    }
  }, [])

  const schedulePreview = useCallback((pattern: string, matchKind: string) => {
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current)
    previewTimerRef.current = setTimeout(() => {
      void fetchPreview(pattern, matchKind)
    }, 300)
  }, [fetchPreview])

  const isNewFormValid = useMemo(() => {
    if (shareError) return false
    if (patternError) return false
    return true
  }, [shareError, patternError])

  async function load() {
    const requestId = ++loadRequestRef.current
    setErr(null)
    try {
      const { sort: s, dir: d } = rulesSortRef.current
      const ruleQs = s ? `?sort=${s}&dir=${d}` : ''
      const nextRules = await getJson<Rule[]>(`/api/rules${ruleQs}`)
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
  }, [rulesSort, rulesDir])

  useEffect(() => {
    void getJson<{ categories: CategoryHint[] }>('/api/transactions/category-hints')
      .then((data) => setCategoryHints(data.categories))
      .catch(() => setCategoryHints([]))
  }, [])

  async function handleExport() {
    setExportLoading(true)
    try {
      const resp = await fetch('/api/rules/export', { credentials: 'include' })
      if (!resp.ok) throw new Error(`Export failed: ${resp.status}`)
      const blob = await resp.blob()
      const today = new Date().toISOString().slice(0, 10)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `cashflow-rules-${today}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      showToast({ title: e instanceof Error ? e.message : 'Export failed', variant: 'destructive' })
    } finally {
      setExportLoading(false)
    }
  }

  async function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const fd = new FormData(form)
    if (!validateShares(newPctMe, newPctPartner, newSplitType)) return
    if (patternError) return
    if (danglingLabelIds.length > 0) {
      setErr('Tag no longer exists — remove or pick another before saving.')
      return
    }
    setErr(null)
    try {
      // Convert share values from 0–100 (display) to 0–1 (stored).
      const pctMeRaw = fd.get('pctMe') ? String(fd.get('pctMe')) : null
      const pctPartnerRaw = fd.get('pctPartner') ? String(fd.get('pctPartner')) : null
      const pctMe = pctMeRaw ? String(parseFloat(pctMeRaw) / 100) : null
      const pctPartner = pctPartnerRaw ? String(parseFloat(pctPartnerRaw) / 100) : null

      const category = String(fd.get('category') ?? '') || null
      const isBusiness = fd.get('isBusiness') === 'on'
      const splitType = String(fd.get('splitType') ?? 'me')

      // Build the composable actions list (issue #795): the scalar-backed
      // effects plus any set_label / set_alert rows. The backend re-derives
      // the scalar columns from these, keeping both representations in sync.
      const actions: RuleAction[] = []
      if (category) actions.push({ type: 'set_category', payload: { category } })
      if (isBusiness) actions.push({ type: 'set_business', payload: { isBusiness: true } })
      if (splitType !== 'me' || pctMe != null || pctPartner != null) {
        actions.push({ type: 'set_split', payload: { splitType, pctMe, pctPartner } })
      }
      for (const labelId of newLabelIds) {
        actions.push({ type: 'set_label', payload: { labelId } })
      }
      if (alertEnabled) {
        actions.push({
          type: 'set_alert',
          payload: {
            severity: alertSeverity,
            ...(alertTitle.trim() ? { title: alertTitle.trim() } : {}),
            ...(alertBody.trim() ? { body: alertBody.trim() } : {}),
          },
        })
      }

      await postJson('/api/rules', {
        merchantPattern: String(fd.get('merchantPattern') ?? ''),
        matchKind: String(fd.get('matchKind') ?? 'substring'),
        priority: Number(fd.get('priority') ?? 0),
        category,
        isBusiness,
        splitType,
        pctMe,
        pctPartner,
        actions,
      })
      form.reset()
      setRuleCategory('')
      setNewPattern('')
      setNewMatchKind('substring')
      setNewSplitType('me')
      setNewPctMe('')
      setNewPctPartner('')
      setNewLabelIds([])
      setAlertEnabled(false)
      setAlertSeverity('info')
      setAlertTitle('')
      setAlertBody('')
      setShareError(null)
      setPatternError(null)
      setPreviewState(null)
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

  return (
    <>
    <div className="page">
      <PageHeader
        title="Rules"
        description="Match merchants on import so category, business, and split defaults land in the right place."
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => void handleExport()}
              disabled={exportLoading || rules.length === 0}
              title={rules.length === 0 ? 'No rules to export.' : undefined}
            >
              {exportLoading ? 'Exporting…' : 'Export rules'}
            </Button>
            <Button variant="outline" onClick={() => setImportModalOpen(true)}>
              Import rules
            </Button>
          </>
        }
      />
      {err && <Alert variant="error" className="mb-4">{err}</Alert>}
      <RulesHealthSection onAfterCreate={() => void load()} />
      <Card className="mb-4">
        <form onSubmit={onCreate}>
        <SectionHeader
          title="New rule"
          description="Reuse an existing category when possible to keep reports tidy."
          actions={
            <Badge variant="count">
              {categoryLabels.length} categories
            </Badge>
          }
        />
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,180px),1fr))]">
          <label>
            Pattern
            <input
              name="merchantPattern"
              required
              placeholder="merchant text"
              value={newPattern}
              onChange={(e) => {
                setNewPattern(e.target.value)
                schedulePreview(e.target.value, newMatchKind)
              }}
              onBlur={() => {
                if (newMatchKind === 'regex' && newPattern) {
                  void fetchPreview(newPattern, newMatchKind)
                }
              }}
            />
            {previewState === 'counting' && (
              <span className="text-xs italic text-muted-foreground">Counting…</span>
            )}
            {previewState !== null && previewState !== 'counting' && (
              'error' in previewState ? (
                <span className="text-xs text-destructive">
                  Invalid pattern: {previewState.error}
                </span>
              ) : (
                <span className="text-xs italic text-muted-foreground">
                  {previewState.matches >= 500
                    ? 'matches 500+ existing transactions'
                    : `matches ${previewState.matches} existing transaction${previewState.matches === 1 ? '' : 's'}`}
                </span>
              )
            )}
          </label>
          <label>
            Match type
            <select
              name="matchKind"
              value={newMatchKind}
              onChange={(e) => {
                setNewMatchKind(e.target.value)
                setPatternError(null)
                schedulePreview(newPattern, e.target.value)
              }}
            >
              <option value="substring">substring</option>
              <option value="regex">regex</option>
            </select>
            <span className="text-xs text-muted-foreground">
              substring matches any part of the description; regex is for patterns (advanced).
            </span>
            {patternError && (
              <span className="text-xs text-destructive" role="alert">
                {patternError}
              </span>
            )}
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
              value={newSplitType}
              onChange={(e) => {
                setNewSplitType(e.target.value)
                validateShares(newPctMe, newPctPartner, e.target.value)
              }}
            >
              <option value="me">me</option>
              <option value="partner">partner</option>
              <option value="shared">shared</option>
            </select>
          </label>
          {newSplitType === 'shared' && (
          <>
          <label>
            Your share (%)
            <input
              name="pctMe"
              type="number"
              min={0}
              max={100}
              step={0.01}
              placeholder="50"
              value={newPctMe}
              onChange={(e) => {
                setNewPctMe(e.target.value)
                validateShares(e.target.value, newPctPartner, newSplitType)
              }}
            />
          </label>
          <label>
            Partner's share (%)
            <input
              name="pctPartner"
              type="number"
              min={0}
              max={100}
              step={0.01}
              placeholder="50"
              value={newPctPartner}
              onChange={(e) => {
                setNewPctPartner(e.target.value)
                validateShares(newPctMe, e.target.value, newSplitType)
              }}
            />
          </label>
          </>
          )}
          {newSplitType === 'shared' && (
            <div className="col-span-full">
              <span className="text-xs text-muted-foreground">Must sum to 100%</span>
              {shareError && (
                <span className="text-xs text-destructive ml-2" role="alert">
                  {shareError}
                </span>
              )}
            </div>
          )}

          {/* Issue #795 — Add tag action rows. */}
          <div className="col-span-full" data-testid="rule-label-action">
            <span className="block text-sm font-medium mb-1">Add tag</span>
            {labelsLoading ? (
              <span className="text-xs text-muted-foreground">Loading tags…</span>
            ) : labels.length === 0 ? (
              <span className="text-xs text-muted-foreground">
                No tags yet — create one in Settings → Labels.
              </span>
            ) : (
              <div className="flex flex-wrap gap-2">
                {labels.map((l) => {
                  const selected = newLabelIds.includes(l.id)
                  return (
                    <button
                      key={l.id}
                      type="button"
                      aria-pressed={selected}
                      className={
                        selected
                          ? 'rounded-full border border-primary bg-primary/10 px-3 py-1 text-xs'
                          : 'rounded-full border border-input px-3 py-1 text-xs'
                      }
                      onClick={() =>
                        setNewLabelIds((ids) =>
                          ids.includes(l.id) ? ids.filter((x) => x !== l.id) : [...ids, l.id],
                        )
                      }
                    >
                      {l.name}
                    </button>
                  )
                })}
              </div>
            )}
            {danglingLabelIds.length > 0 && (
              <span className="text-xs text-destructive" role="alert">
                Tag no longer exists — remove or pick another.
              </span>
            )}
          </div>

          {/* Issue #795 — Raise alert action row. */}
          <div className="col-span-full" data-testid="rule-alert-action">
            <label className="check">
              <input
                type="checkbox"
                checked={alertEnabled}
                onChange={(e) => setAlertEnabled(e.target.checked)}
              />{' '}
              Raise alert when this rule fires
            </label>
            {alertEnabled && (
              <div className="mt-2 flex flex-col gap-2">
                <label>
                  Severity
                  <select
                    name="alertSeverity"
                    value={alertSeverity}
                    onChange={(e) => setAlertSeverity(e.target.value as AlertSeverity)}
                  >
                    <option value="info">info</option>
                    <option value="warn">warn</option>
                    <option value="critical">critical</option>
                  </select>
                </label>
                <label>
                  Title (optional)
                  <input
                    name="alertTitle"
                    type="text"
                    maxLength={160}
                    value={alertTitle}
                    onChange={(e) => setAlertTitle(e.target.value)}
                    placeholder="Charge from a watched vendor"
                  />
                </label>
                <label>
                  Message (optional)
                  <input
                    name="alertBody"
                    type="text"
                    value={alertBody}
                    onChange={(e) => setAlertBody(e.target.value)}
                    placeholder="A transaction matched this rule."
                  />
                </label>
              </div>
            )}
          </div>
        </div>
        <Button type="submit" disabled={!isNewFormValid || danglingLabelIds.length > 0}>Add rule</Button>
        </form>
      </Card>

      {autoSuggestions.length > 0 && (
        <Card className="mb-4">
          <SectionHeader
            title="Auto-rule suggestions"
            description="Patterns we spotted in your recent reviews. Accept to create a rule; dismiss to hide the suggestion."
            actions={
              <Badge variant="count">
                {autoSuggestions.length} suggestion{autoSuggestions.length === 1 ? '' : 's'}
              </Badge>
            }
          />
          <Table>
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
                    <Badge variant="count">
                      {Math.round(s.confidence * 100)}%
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm leading-6 text-muted-foreground">{s.reasoning}</span>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => void acceptAutoSuggestion(s)}
                      >
                        Accept
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void dismissAutoSuggestion(s)}
                      >
                        Dismiss
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {proposals.length > 0 && (
        <Card className="mb-4">
          <SectionHeader
            title="AI rule proposals"
            description="Repeated reviewed merchants that look stable enough to automate."
            actions={
              <Badge variant="count">{proposals.length} proposals</Badge>
            }
          />
          <Table>
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
                    <Button type="button" variant="secondary" size="sm" onClick={() => void approveProposal(p)}>
                      Approve
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <Card className="mb-4">
        <SectionHeader
          title="Existing rules"
          description="Higher priority wins when several patterns match the same transaction."
          actions={
            <Badge variant="count">{rules.length} rules</Badge>
          }
        />
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTableHead field="name" label="Pattern" currentSort={rulesSort} dir={rulesDir} onSort={toggleRulesSort} />
              <SortableTableHead field="matchType" label="Match" currentSort={rulesSort} dir={rulesDir} onSort={toggleRulesSort} />
              <SortableTableHead field="priority" label="Pri" currentSort={rulesSort} dir={rulesDir} onSort={toggleRulesSort} />
              <TableHead>Category</TableHead>
              <TableHead>Biz</TableHead>
              <TableHead>Split</TableHead>
              <TableHead>Usage</TableHead>
              <SortableTableHead field="updatedAt" label="Updated" currentSort={rulesSort} dir={rulesDir} onSort={toggleRulesSort} />
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.length === 0 ? (
              <EmptyTableRow
                colSpan={9}
                title="No rules yet. Add a pattern above to start automating imports."
                description="Rules set default category, business flag, and split for matching merchants on import."
              />
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
                  <TableCell className="text-muted-foreground">{r.updatedAt ? r.updatedAt.slice(0, 10) : '—'}</TableCell>
                  <TableCell>
                    <Button type="button" variant="destructive" size="sm" onClick={() => void remove(r)}>
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
    {confirm.dialog}
    <ImportRulesModal
      open={importModalOpen}
      onOpenChange={setImportModalOpen}
      currentRuleCount={rules.length}
      onSuccess={() => void load()}
    />
    </>
  )
}
