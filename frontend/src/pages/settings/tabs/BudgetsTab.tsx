import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Edit3, Plus, Trash2 } from 'lucide-react'
import { CategoryIcon } from '../../../components/CategoryIcon'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useConfirm } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useToast } from '@/components/ui/toast'
import { deleteReq, getJson, postJson } from '../../../lib/api'
import { formatMoney } from '../../../lib/formatMoney'
import type {
  Budget,
  BudgetInput,
  BudgetPeriod,
  BudgetScope,
  BudgetsResponse,
} from '../../../types/api'

const BUDGET_CATEGORY_OVERALL = ''
const DEFAULT_BUDGET_CURRENCY = 'CAD'
const DEFAULT_BUDGET_SCOPE: BudgetScope = 'household'
const DEFAULT_BUDGET_PERIOD: BudgetPeriod = 'monthly'

/**
 * Choices the "Alert me at" multi-select chips offer for budget breach
 * notifications (issue #268). Picked to match the issue spec — 80% as the
 * mid-period warning, 100% as the boundary, 120% as the "you blew through
 * it" callout. Users can still PATCH the server with any 1..500 integer via
 * the API, but the UI keeps the choices opinionated.
 */
const BUDGET_ALERT_THRESHOLD_CHOICES: readonly number[] = [80, 100, 120] as const
const DEFAULT_BUDGET_ALERT_THRESHOLDS: readonly number[] = [80, 100, 120] as const

type CategoryHint = { label: string; usageCount: number }

type BudgetFormState = {
  category: string
  currency: string
  amount: string
  scope: BudgetScope
  period: BudgetPeriod
  rolloverEnabled: boolean
  /**
   * Set of thresholds the user has chosen for proactive alerts. Stored as
   * Set<number> in form state for O(1) toggle semantics; serialized to a
   * sorted array when we POST/PUT.
   */
  alertThresholds: Set<number>
}

const emptyBudgetForm: BudgetFormState = {
  category: BUDGET_CATEGORY_OVERALL,
  currency: DEFAULT_BUDGET_CURRENCY,
  amount: '',
  scope: DEFAULT_BUDGET_SCOPE,
  period: DEFAULT_BUDGET_PERIOD,
  rolloverEnabled: false,
  alertThresholds: new Set<number>(DEFAULT_BUDGET_ALERT_THRESHOLDS),
}

/** Map a Set to the sorted-array shape the API contract expects. */
function thresholdsToArray(set: Set<number>): number[] {
  return Array.from(set).sort((a, b) => a - b)
}

/**
 * Multi-select chips for "Alert me at" (issue #268). Toggling a chip flips
 * its membership in the parent's `Set<number>`; an unticked chip means the
 * cron will NOT fire that threshold for this budget.
 *
 * The choices live in `BUDGET_ALERT_THRESHOLD_CHOICES` — a literal array
 * keeps Tailwind JIT happy with the chip classes (no template-string
 * interpolation needed because all classes are static here).
 */
function AlertThresholdChips({
  idPrefix,
  selected,
  onChange,
}: {
  idPrefix: string
  selected: Set<number>
  onChange: (next: Set<number>) => void
}) {
  return (
    <fieldset className="mt-1">
      <legend className="text-sm font-medium text-foreground">
        Alert me at
      </legend>
      <div className="flex flex-wrap gap-2 mt-1">
        {BUDGET_ALERT_THRESHOLD_CHOICES.map((threshold) => {
          const isOn = selected.has(threshold)
          return (
            <label
              key={threshold}
              htmlFor={`${idPrefix}-threshold-${threshold}`}
              className={
                isOn
                  ? 'inline-flex items-center gap-1 px-2 py-1 text-xs rounded-full bg-success-bg text-positive cursor-pointer'
                  : 'inline-flex items-center gap-1 px-2 py-1 text-xs rounded-full bg-muted text-muted-foreground cursor-pointer'
              }
            >
              <input
                id={`${idPrefix}-threshold-${threshold}`}
                type="checkbox"
                className="sr-only"
                checked={isOn}
                aria-label={`Alert at ${threshold}%`}
                onChange={(e) => {
                  const next = new Set(selected)
                  if (e.target.checked) {
                    next.add(threshold)
                  } else {
                    next.delete(threshold)
                  }
                  onChange(next)
                }}
              />
              {threshold}%
            </label>
          )
        })}
      </div>
      <p className="muted block text-xs mt-1">
        A daily check sends an in-app notification once spend crosses any
        selected percent. Untick all chips to silence alerts for this budget.
      </p>
    </fieldset>
  )
}

/**
 * Human labels for the scope dropdown. Kept here (not in types/api.ts) so
 * shared types remain plain data and don't pull in i18n / UI concerns.
 */
const SCOPE_OPTIONS: Array<{ value: BudgetScope; label: string; hint: string }> = [
  {
    value: 'household',
    label: 'Household (shared spend)',
    hint: 'Counts shared transactions across the household.',
  },
  {
    value: 'personal',
    label: 'Personal (your private spend)',
    hint: 'Counts your own private, non-business spend only.',
  },
  {
    value: 'partner',
    label: 'Partner',
    hint: "Counts a partner's spend.",
  },
  {
    value: 'business',
    label: 'Business',
    hint: 'Counts transactions marked as business expenses.',
  },
]

const PERIOD_OPTIONS: Array<{ value: BudgetPeriod; label: string }> = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'weekly', label: 'Weekly (Mon–Sun)' },
  { value: 'annual', label: 'Annual' },
]

/**
 * Wrapper for `fetch` PUT against /api/budgets/:id. The shared `lib/api.ts`
 * helper set exposes POST/PATCH/DELETE but not PUT, and the budgets route
 * uses PUT for full replacement semantics. Mirrors the credential and
 * error-handling contract of the shared helpers.
 */
async function putBudget(id: number, body: BudgetInput): Promise<Budget> {
  const base = import.meta.env.VITE_API_BASE ?? ''
  const res = await fetch(`${base}/api/budgets/${id}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let message = res.statusText
    const raw = await res.text()
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { error?: string }
        message = parsed.error ?? raw
      } catch {
        message = raw
      }
    }
    throw new Error(message)
  }
  return (await res.json()) as Budget
}

export function BudgetsTab() {
  const { showToast } = useToast()
  const confirm = useConfirm()

  const [budgets, setBudgets] = useState<Budget[]>([])
  const [budgetCategoryHints, setBudgetCategoryHints] = useState<string[]>([])
  const [budgetForm, setBudgetForm] = useState<BudgetFormState>(emptyBudgetForm)
  const [budgetSubmitting, setBudgetSubmitting] = useState(false)
  const [budgetEditId, setBudgetEditId] = useState<number | null>(null)
  const [budgetEditForm, setBudgetEditForm] = useState<BudgetFormState>(emptyBudgetForm)
  const [budgetEditSaving, setBudgetEditSaving] = useState(false)

  const loadBudgets = useCallback(async () => {
    try {
      const resp = await getJson<BudgetsResponse>('/api/budgets')
      setBudgets(resp.data)
    } catch {
      // Errors surfaced via toast in handlers
    }
  }, [])

  useEffect(() => {
    void loadBudgets()
    // Category-hints is the same source the Rules and Review pages use. It
    // returns each known final category with its usage count; we only need
    // the labels here, sorted alphabetically for the dropdown.
    void getJson<{ categories: CategoryHint[] }>('/api/transactions/category-hints')
      .then((data) => {
        const labels = data.categories
          .map((c) => c.label)
          .filter((label) => label.length > 0)
        labels.sort((a, b) => a.localeCompare(b))
        setBudgetCategoryHints(labels)
      })
      .catch(() => setBudgetCategoryHints([]))
  }, [loadBudgets])

  /**
   * Normalize a budget form into the POST/PUT body the route expects.
   * Returns `null` if validation fails — caller surfaces a toast.
   *
   * Category is `null` when the user leaves it on "Overall" (sentinel value
   * is the empty string in form state). Amount must parse as a positive
   * number; currency is uppercased and length-checked. The backend repeats
   * these checks so we do not need to be exhaustive — we just want to avoid
   * obviously-invalid requests round-tripping.
   */
  function buildBudgetInput(form: BudgetFormState): BudgetInput | null {
    const currency = form.currency.trim().toUpperCase()
    if (currency.length !== 3) return null
    const amount = Number(form.amount)
    if (!Number.isFinite(amount) || amount <= 0) return null
    const category = form.category.trim() ? form.category.trim() : null
    return {
      category,
      currency,
      amount,
      period: form.period,
      scope: form.scope,
      rolloverEnabled: form.rolloverEnabled,
      alertThresholds: thresholdsToArray(form.alertThresholds),
    }
  }

  async function createBudget(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const input = buildBudgetInput(budgetForm)
    if (!input) {
      showToast({
        title: 'Could not add budget',
        description: 'Pick a currency and a positive amount.',
        variant: 'destructive',
      })
      return
    }
    setBudgetSubmitting(true)
    try {
      await postJson<Budget>('/api/budgets', input)
      setBudgetForm(emptyBudgetForm)
      await loadBudgets()
      showToast({
        title: `Added budget for ${input.category ?? 'Overall'}`,
        description: `${formatMoney(input.amount, input.currency)} per ${budgetForm.period}`,
        variant: 'success',
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not add budget'
      showToast({
        title: 'Could not add budget',
        description: message,
        variant: 'destructive',
      })
    } finally {
      setBudgetSubmitting(false)
    }
  }

  function openBudgetEdit(budget: Budget) {
    setBudgetEditId(budget.id)
    setBudgetEditForm({
      category: budget.category ?? BUDGET_CATEGORY_OVERALL,
      currency: budget.currency,
      amount: String(Number(budget.amount)),
      scope: budget.scope,
      period: budget.period,
      rolloverEnabled: budget.rolloverEnabled,
      alertThresholds: new Set<number>(budget.alertThresholds ?? DEFAULT_BUDGET_ALERT_THRESHOLDS),
    })
  }

  function cancelBudgetEdit() {
    setBudgetEditId(null)
    setBudgetEditForm(emptyBudgetForm)
    setBudgetEditSaving(false)
  }

  async function saveBudgetEdit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (budgetEditId == null) return
    const input = buildBudgetInput(budgetEditForm)
    if (!input) {
      showToast({
        title: 'Could not save budget',
        description: 'Pick a currency and a positive amount.',
        variant: 'destructive',
      })
      return
    }
    setBudgetEditSaving(true)
    try {
      await putBudget(budgetEditId, input)
      cancelBudgetEdit()
      await loadBudgets()
      showToast({
        title: 'Budget updated',
        variant: 'success',
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not save budget'
      showToast({
        title: 'Could not save budget',
        description: message,
        variant: 'destructive',
      })
      setBudgetEditSaving(false)
    }
  }

  async function deleteBudget(budget: Budget) {
    const label = budget.category ?? 'Overall'
    const ok = await confirm({
      title: 'Delete budget?',
      description: `${label} (${budget.currency}) will stop appearing on the dashboard.`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await deleteReq(`/api/budgets/${budget.id}`)
      await loadBudgets()
      showToast({ title: 'Budget removed', variant: 'success' })
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not delete budget'
      showToast({
        title: 'Could not delete budget',
        description: message,
        variant: 'destructive',
      })
    }
  }

  // Stable display ordering for budgets — currency first, then category
  // (with "Overall" floated to the top of each currency group). The route
  // already orders this way, but UI updates can interleave optimistic
  // changes, so sort defensively.
  const sortedBudgets = useMemo(() => {
    return [...budgets].sort((a, b) => {
      if (a.currency !== b.currency) return a.currency.localeCompare(b.currency)
      if (a.category == null && b.category != null) return -1
      if (a.category != null && b.category == null) return 1
      return (a.category ?? '').localeCompare(b.category ?? '')
    })
  }, [budgets])

  const budgetCategoryDatalistId = 'settings-budget-category-options'

  function scopeLabel(scope: BudgetScope): string {
    return SCOPE_OPTIONS.find((opt) => opt.value === scope)?.label ?? scope
  }

  function periodLabel(period: BudgetPeriod): string {
    return PERIOD_OPTIONS.find((opt) => opt.value === period)?.label ?? period
  }

  return (
    <>
      <Card className="accountsFormCard">
        <div className="accountsCardHeader">
          <div>
            <h2>Budgets</h2>
            <p className="muted">
              Set a target for a single category or an overall cap, per scope
              (household, personal, partner, business). The dashboard tracks
              spend against each target plus how much of the period has
              elapsed.
            </p>
          </div>
        </div>
        {sortedBudgets.length === 0 ? (
          <EmptyState
            title="No budgets yet."
            description="Add one to track progress with pacing comparison."
          />
        ) : (
          <div className="tableWrap">
            <Table className="table">
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Currency</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead aria-label="Actions" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedBudgets.map((budget) => {
                  const isEditing = budgetEditId === budget.id
                  if (isEditing) {
                    return (
                      <TableRow key={budget.id}>
                        <TableCell colSpan={6}>
                          <form onSubmit={saveBudgetEdit}>
                            <div className="formGrid">
                              <Label htmlFor={`settings-budget-edit-category-${budget.id}`}>
                                Category
                                <Input
                                  id={`settings-budget-edit-category-${budget.id}`}
                                  list={budgetCategoryDatalistId}
                                  value={budgetEditForm.category}
                                  onChange={(e) =>
                                    setBudgetEditForm((prev) => ({
                                      ...prev,
                                      category: e.target.value,
                                    }))
                                  }
                                  placeholder="Overall"
                                  autoComplete="off"
                                />
                              </Label>
                              <Label htmlFor={`settings-budget-edit-scope-${budget.id}`}>
                                Scope
                                <NativeSelect
                                  id={`settings-budget-edit-scope-${budget.id}`}
                                  value={budgetEditForm.scope}
                                  onChange={(e) =>
                                    setBudgetEditForm((prev) => ({
                                      ...prev,
                                      scope: e.target.value as BudgetScope,
                                    }))
                                  }
                                >
                                  {SCOPE_OPTIONS.map((opt) => (
                                    <option key={opt.value} value={opt.value}>
                                      {opt.label}
                                    </option>
                                  ))}
                                </NativeSelect>
                              </Label>
                              <Label htmlFor={`settings-budget-edit-period-${budget.id}`}>
                                Period
                                <NativeSelect
                                  id={`settings-budget-edit-period-${budget.id}`}
                                  value={budgetEditForm.period}
                                  onChange={(e) =>
                                    setBudgetEditForm((prev) => ({
                                      ...prev,
                                      period: e.target.value as BudgetPeriod,
                                    }))
                                  }
                                >
                                  {PERIOD_OPTIONS.map((opt) => (
                                    <option key={opt.value} value={opt.value}>
                                      {opt.label}
                                    </option>
                                  ))}
                                </NativeSelect>
                              </Label>
                              <Label htmlFor={`settings-budget-edit-currency-${budget.id}`}>
                                Currency
                                <Input
                                  id={`settings-budget-edit-currency-${budget.id}`}
                                  value={budgetEditForm.currency}
                                  onChange={(e) =>
                                    setBudgetEditForm((prev) => ({
                                      ...prev,
                                      currency: e.target.value.toUpperCase().slice(0, 3),
                                    }))
                                  }
                                  required
                                  maxLength={3}
                                  autoComplete="off"
                                />
                              </Label>
                              <Label htmlFor={`settings-budget-edit-amount-${budget.id}`}>
                                Amount
                                <Input
                                  id={`settings-budget-edit-amount-${budget.id}`}
                                  type="number"
                                  step="0.01"
                                  min="0.01"
                                  value={budgetEditForm.amount}
                                  onChange={(e) =>
                                    setBudgetEditForm((prev) => ({
                                      ...prev,
                                      amount: e.target.value,
                                    }))
                                  }
                                  required
                                />
                              </Label>
                              <Label htmlFor={`settings-budget-edit-rollover-${budget.id}`} className="inline-flex items-center gap-2">
                                <input
                                  id={`settings-budget-edit-rollover-${budget.id}`}
                                  type="checkbox"
                                  checked={budgetEditForm.rolloverEnabled}
                                  onChange={(e) =>
                                    setBudgetEditForm((prev) => ({
                                      ...prev,
                                      rolloverEnabled: e.target.checked,
                                    }))
                                  }
                                />
                                <span>
                                  Roll unused budget forward
                                  <span className="muted block text-xs">
                                    (toggle saved; carry-over behavior is a planned follow-up)
                                  </span>
                                </span>
                              </Label>
                              <AlertThresholdChips
                                idPrefix={`settings-budget-edit-${budget.id}`}
                                selected={budgetEditForm.alertThresholds}
                                onChange={(next) =>
                                  setBudgetEditForm((prev) => ({
                                    ...prev,
                                    alertThresholds: next,
                                  }))
                                }
                              />
                            </div>
                            <div className="row">
                              <Button
                                type="submit"
                                size="sm"
                                disabled={budgetEditSaving}
                              >
                                Save
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={cancelBudgetEdit}
                                disabled={budgetEditSaving}
                              >
                                Cancel
                              </Button>
                            </div>
                          </form>
                        </TableCell>
                      </TableRow>
                    )
                  }
                  return (
                    <TableRow key={budget.id}>
                      <TableCell>
                        <span className="inline-flex items-center gap-1.5">
                          <CategoryIcon name={budget.category} />
                          {budget.category ?? 'Overall'}
                        </span>
                      </TableCell>
                      <TableCell>{scopeLabel(budget.scope)}</TableCell>
                      <TableCell>{periodLabel(budget.period)}</TableCell>
                      <TableCell>{budget.currency}</TableCell>
                      <TableCell>{formatMoney(Number(budget.amount), budget.currency)}</TableCell>
                      <TableCell>
                        <div className="row">
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={() => openBudgetEdit(budget)}
                          >
                            <Edit3 aria-hidden="true" />
                            Edit
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            onClick={() => void deleteBudget(budget)}
                          >
                            <Trash2 aria-hidden="true" />
                            Delete
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
        <form onSubmit={createBudget}>
          <div className="formGrid">
            <Label htmlFor="settings-budget-category">
              Category
              <NativeSelect
                id="settings-budget-category"
                value={budgetForm.category}
                onChange={(e) =>
                  setBudgetForm((prev) => ({ ...prev, category: e.target.value }))
                }
              >
                <option value={BUDGET_CATEGORY_OVERALL}>Overall (all categories)</option>
                {budgetCategoryHints.map((label) => (
                  <option key={label} value={label}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            </Label>
            <Label htmlFor="settings-budget-scope">
              Scope
              <NativeSelect
                id="settings-budget-scope"
                value={budgetForm.scope}
                onChange={(e) =>
                  setBudgetForm((prev) => ({
                    ...prev,
                    scope: e.target.value as BudgetScope,
                  }))
                }
              >
                {SCOPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </NativeSelect>
            </Label>
            <Label htmlFor="settings-budget-period">
              Period
              <NativeSelect
                id="settings-budget-period"
                value={budgetForm.period}
                onChange={(e) =>
                  setBudgetForm((prev) => ({
                    ...prev,
                    period: e.target.value as BudgetPeriod,
                  }))
                }
              >
                {PERIOD_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </NativeSelect>
            </Label>
            <Label htmlFor="settings-budget-currency">
              Currency
              <Input
                id="settings-budget-currency"
                value={budgetForm.currency}
                onChange={(e) =>
                  setBudgetForm((prev) => ({
                    ...prev,
                    currency: e.target.value.toUpperCase().slice(0, 3),
                  }))
                }
                required
                maxLength={3}
                autoComplete="off"
                placeholder="CAD"
              />
            </Label>
            <Label htmlFor="settings-budget-amount">
              Amount
              <Input
                id="settings-budget-amount"
                type="number"
                step="0.01"
                min="0.01"
                value={budgetForm.amount}
                onChange={(e) =>
                  setBudgetForm((prev) => ({ ...prev, amount: e.target.value }))
                }
                required
                placeholder="500.00"
              />
            </Label>
            <Label htmlFor="settings-budget-rollover" className="inline-flex items-center gap-2">
              <input
                id="settings-budget-rollover"
                type="checkbox"
                checked={budgetForm.rolloverEnabled}
                onChange={(e) =>
                  setBudgetForm((prev) => ({
                    ...prev,
                    rolloverEnabled: e.target.checked,
                  }))
                }
              />
              <span>
                Roll unused budget forward
                <span className="muted block text-xs">
                  (toggle saved; carry-over behavior is a planned follow-up)
                </span>
              </span>
            </Label>
            <AlertThresholdChips
              idPrefix="settings-budget-create"
              selected={budgetForm.alertThresholds}
              onChange={(next) =>
                setBudgetForm((prev) => ({
                  ...prev,
                  alertThresholds: next,
                }))
              }
            />
          </div>
          <Button type="submit" disabled={budgetSubmitting}>
            <Plus aria-hidden="true" />
            Add budget
          </Button>
        </form>
        {/* Datalist powers the inline edit category Input — the create form
            uses a NativeSelect with the same labels so the dropdown stays
            keyboard-friendly. Both share one option set. */}
        <datalist id={budgetCategoryDatalistId}>
          {budgetCategoryHints.map((label) => (
            <option key={label} value={label} />
          ))}
        </datalist>
      </Card>
      {confirm.dialog}
    </>
  )
}
