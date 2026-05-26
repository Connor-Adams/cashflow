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

type CategoryHint = { label: string; usageCount: number }

type BudgetFormState = {
  category: string
  currency: string
  amount: string
  scope: BudgetScope
  period: BudgetPeriod
  rolloverEnabled: boolean
}

const emptyBudgetForm: BudgetFormState = {
  category: BUDGET_CATEGORY_OVERALL,
  currency: DEFAULT_BUDGET_CURRENCY,
  amount: '',
  scope: DEFAULT_BUDGET_SCOPE,
  period: DEFAULT_BUDGET_PERIOD,
  rolloverEnabled: false,
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
