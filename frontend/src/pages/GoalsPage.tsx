import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Badge, Icon } from '@connor-adams/designsystem'
import { Button } from '@connor-adams/designsystem'
import { Card } from '@connor-adams/designsystem'
import { useConfirm } from '@/lib/ds-extras'
import { EmptyState } from '@connor-adams/designsystem'
import { Grid } from '@/lib/ds-extras'
import { Input } from '@connor-adams/designsystem'
import { Label } from '@connor-adams/designsystem'
import { NativeSelect } from '@connor-adams/designsystem'
import { PageHeader } from '@/components/ui/page-header'
import { SectionHeader } from '@/components/ui/section-header'
import { SkeletonRow } from '@/lib/ds-extras'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@connor-adams/designsystem'
import { Textarea } from '@connor-adams/designsystem'
import { useToast } from '@/components/ui/toast'
import { useNavigate } from 'react-router-dom'
import { deleteReq, getJson, postJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import { safeNum } from '../lib/num'
import type {
  Account,
  FinancialGoal,
  FinancialGoalInput,
  FinancialGoalPatch,
  FinancialGoalsResponse,
  FinancialGoalStatus,
  GoalForecastStatus,
  GoalProjectionResponse,
} from '../types/api'

const DEFAULT_CURRENCY = 'CAD'

/**
 * Wrapper for `fetch` PUT against /api/goals/:id. The shared `lib/api.ts`
 * helper set exposes POST/PATCH/DELETE but not PUT, so we inline a tiny
 * client here. Mirrors the credential and error-handling contract of the
 * shared helpers — also mirrors the same pattern used in PlannedEventsPage.
 */
async function putGoal(
  id: number,
  body: FinancialGoalPatch,
): Promise<FinancialGoal> {
  const base = import.meta.env.VITE_API_BASE ?? ''
  const res = await fetch(`${base}/api/goals/${id}`, {
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
  return (await res.json()) as FinancialGoal
}

const GOAL_STATUS_OPTIONS: Array<{ value: FinancialGoalStatus; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'completed', label: 'Completed' },
]

// Tailwind v4 JIT needs literal class names — Sidebar/Theme docs note this.
// Look up colour classes per status via tables instead of building strings
// dynamically so the bundler keeps them.
const STATUS_BADGE: Record<FinancialGoalStatus, string> = {
  active: 'bg-info-bg text-info-foreground',
  paused: 'bg-warning-bg text-warning-foreground',
  completed: 'bg-success-bg text-success-foreground',
}

// Forecast-grounded badge (#653). Literal class strings per status — Tailwind
// v4 JIT needs literals, no dynamic string building. Mirrors the semantic
// design-system tokens the rest of the page uses.
const FORECAST_BADGE: Record<GoalForecastStatus, string> = {
  completed: 'bg-success-bg text-success-foreground',
  on_track: 'bg-success-bg text-success-foreground',
  at_risk: 'bg-warning-bg text-warning-foreground',
  off_track: 'bg-danger-bg text-danger',
  no_deadline: 'bg-muted text-muted-foreground',
  cant_validate: 'bg-muted text-muted-foreground',
}

const FORECAST_LABEL: Record<GoalForecastStatus, string> = {
  completed: 'Completed',
  on_track: 'On track',
  at_risk: 'At risk',
  off_track: 'Off track',
  no_deadline: 'No deadline',
  cant_validate: "Can't validate",
}

function statusLabel(status: FinancialGoalStatus): string {
  return GOAL_STATUS_OPTIONS.find((o) => o.value === status)?.label ?? status
}

type FormState = {
  name: string
  targetAmount: string
  currentAmount: string
  currency: string
  targetDate: string
  monthlyContribution: string
  linkedAccountId: string
  priority: string
  status: FinancialGoalStatus
  notes: string
}

function emptyForm(currency: string = DEFAULT_CURRENCY): FormState {
  return {
    name: '',
    targetAmount: '',
    currentAmount: '',
    currency,
    targetDate: '',
    monthlyContribution: '',
    linkedAccountId: '',
    priority: '0',
    status: 'active',
    notes: '',
  }
}

function rowToForm(row: FinancialGoal): FormState {
  return {
    name: row.name,
    targetAmount: String(Number(row.targetAmount)),
    currentAmount: String(Number(row.currentAmount)),
    currency: row.currency,
    targetDate: row.targetDate ?? '',
    monthlyContribution:
      row.monthlyContribution == null
        ? ''
        : String(Number(row.monthlyContribution)),
    linkedAccountId: row.linkedAccountId == null ? '' : String(row.linkedAccountId),
    priority: String(row.priority),
    status: row.status,
    notes: row.notes ?? '',
  }
}

const NEGATIVE_AMOUNT_ERROR = "Amount can't be negative."

/** Returns the inline error for a money field whose raw input is negative, else
 *  empty. Empty input and a real `0` are not errors here (the positive-amount
 *  requirement is enforced separately by buildInput). */
function negativeAmountError(raw: string): string {
  if (raw.trim() === '') return ''
  const n = Number(raw)
  return Number.isFinite(n) && n < 0 ? NEGATIVE_AMOUNT_ERROR : ''
}

function buildInput(form: FormState): FinancialGoalInput | null {
  const name = form.name.trim()
  if (!name) return null
  const targetAmount = Number(form.targetAmount)
  if (!Number.isFinite(targetAmount) || targetAmount <= 0) return null
  let currentAmount: number | undefined = undefined
  if (form.currentAmount !== '') {
    currentAmount = Number(form.currentAmount)
    if (!Number.isFinite(currentAmount) || currentAmount < 0) return null
  }
  const currency = form.currency.trim().toUpperCase()
  if (currency.length !== 3) return null
  let targetDate: string | null = null
  if (form.targetDate !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.targetDate)) return null
    targetDate = form.targetDate
  }
  let monthlyContribution: number | null = null
  if (form.monthlyContribution !== '') {
    const m = Number(form.monthlyContribution)
    if (!Number.isFinite(m) || m < 0) return null
    monthlyContribution = m
  }
  let linkedAccountId: number | null = null
  if (form.linkedAccountId !== '') {
    const aid = Number.parseInt(form.linkedAccountId, 10)
    if (!Number.isInteger(aid)) return null
    linkedAccountId = aid
  }
  let priority = 0
  if (form.priority !== '') {
    const p = Number.parseInt(form.priority, 10)
    if (!Number.isInteger(p)) return null
    priority = p
  }
  const notes = form.notes.trim()
  return {
    name,
    targetAmount,
    currentAmount,
    currency,
    targetDate,
    monthlyContribution,
    linkedAccountId,
    priority,
    status: form.status,
    notes: notes ? notes : null,
  }
}

function buildPatch(form: FormState): FinancialGoalPatch | null {
  return buildInput(form)
}

export function GoalsPage() {
  const { showToast } = useToast()
  const confirm = useConfirm()
  const navigate = useNavigate()

  const [goals, setGoals] = useState<FinancialGoal[]>([])
  const [projections, setProjections] = useState<Record<number, GoalProjectionResponse>>({})
  const [accounts, setAccounts] = useState<Account[]>([])
  const [form, setForm] = useState<FormState>(emptyForm())
  const [submitting, setSubmitting] = useState(false)
  const [createAttempted, setCreateAttempted] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [editForm, setEditForm] = useState<FormState>(emptyForm())
  const [editSaving, setEditSaving] = useState(false)
  const [editAttempted, setEditAttempted] = useState(false)
  const [statusFilter, setStatusFilter] = useState<FinancialGoalStatus | ''>('active')
  const [loading, setLoading] = useState(true)

  const loadGoals = useCallback(async () => {
    setLoading(true)
    try {
      const path = statusFilter
        ? `/api/goals?status=${encodeURIComponent(statusFilter)}`
        : '/api/goals'
      const resp = await getJson<FinancialGoalsResponse>(path)
      setGoals(resp.data)
      // Fetch projections in parallel for the visible goals.
      const projectionEntries = await Promise.all(
        resp.data.map(async (g) => {
          try {
            const p = await getJson<GoalProjectionResponse>(
              `/api/goals/${g.id}/projection`,
            )
            return [g.id, p] as const
          } catch {
            return null
          }
        }),
      )
      const map: Record<number, GoalProjectionResponse> = {}
      for (const entry of projectionEntries) {
        if (entry) map[entry[0]] = entry[1]
      }
      setProjections(map)
    } catch {
      // Surfaced via toast in handlers
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => {
    void loadGoals()
  }, [loadGoals])

  useEffect(() => {
    void getJson<Account[]>('/api/accounts')
      .then((rows) => setAccounts(rows))
      .catch(() => setAccounts([]))
  }, [])

  const accountOptions = useMemo(() => {
    return accounts
      .filter((a) => a.closedAt == null)
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [accounts])

  const accountNamesById = useMemo(() => {
    const m = new Map<number, string>()
    for (const a of accounts) m.set(a.id, a.name)
    return m
  }, [accounts])

  async function createGoal(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setCreateAttempted(true)
    const input = buildInput(form)
    if (!input) {
      showToast({
        title: 'Could not add goal',
        description:
          'Name and a positive target amount are required. Currency must be 3 letters; date must be YYYY-MM-DD if set.',
        variant: 'destructive',
      })
      return
    }
    setSubmitting(true)
    try {
      await postJson<FinancialGoal>('/api/goals', input)
      setForm(emptyForm(form.currency))
      await loadGoals()
      showToast({
        title: 'Goal added',
        description: `${input.name} — target ${formatMoney(input.targetAmount, input.currency)}`,
        variant: 'success',
        action: { label: 'See in forecast →', onClick: () => navigate('/forecast') },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not add goal'
      showToast({
        title: 'Could not add goal',
        description: message,
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }

  function openEdit(row: FinancialGoal) {
    setEditId(row.id)
    setEditForm(rowToForm(row))
  }

  function cancelEdit() {
    setEditId(null)
    setEditForm(emptyForm())
    setEditSaving(false)
  }

  async function saveEdit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (editId == null) return
    setEditAttempted(true)
    const patch = buildPatch(editForm)
    if (!patch) {
      showToast({
        title: 'Could not save goal',
        description:
          'Name and a positive target amount are required. Currency must be 3 letters; date must be YYYY-MM-DD if set.',
        variant: 'destructive',
      })
      return
    }
    setEditSaving(true)
    try {
      await putGoal(editId, patch)
      cancelEdit()
      await loadGoals()
      showToast({ title: 'Goal updated', variant: 'success', action: { label: 'See in forecast →', onClick: () => navigate('/forecast') } })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not save goal'
      showToast({
        title: 'Could not save goal',
        description: message,
        variant: 'destructive',
      })
      setEditSaving(false)
    }
  }

  async function deleteGoal(row: FinancialGoal) {
    const ok = await confirm({
      title: 'Delete goal?',
      description: `${row.name} will be removed. To keep history, mark it Completed instead.`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await deleteReq(`/api/goals/${row.id}`)
      await loadGoals()
      showToast({ title: 'Goal removed', variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not delete goal'
      showToast({
        title: 'Could not delete goal',
        description: message,
        variant: 'destructive',
      })
    }
  }

  async function archiveGoal(row: FinancialGoal) {
    try {
      await putGoal(row.id, { status: 'completed' })
      await loadGoals()
      showToast({ title: 'Goal archived', variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not archive goal'
      showToast({
        title: 'Could not archive goal',
        description: message,
        variant: 'destructive',
      })
    }
  }

  return (
    <>
      <PageHeader
        title="Goals"
        description="Savings targets, sinking funds, and recurring expense reserves (emergency fund, vacation, taxes, annual insurance)."
      />
      <Card className="mb-4">
        <SectionHeader
          title={
            <span className="flex items-center gap-2">
              <Icon name="target" aria-hidden="true" className="h-5 w-5" />
              Your goals
            </span>
          }
          description={
            goals.length === 0
              ? 'Add a goal below to start tracking progress.'
              : `${goals.length} goal${goals.length === 1 ? '' : 's'} shown.`
          }
          actions={
            <Label htmlFor="goals-status-filter" className="text-sm">
              Status
              <NativeSelect
                id="goals-status-filter"
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(e.target.value as FinancialGoalStatus | '')
                }
              >
                <option value="">All</option>
                {GOAL_STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </NativeSelect>
            </Label>
          }
        />
        {!loading && goals.length === 0 ? (
          <EmptyState
            title="No goals yet."
            description="Add a target below — emergency fund, sinking fund, or upcoming expense."
          />
        ) : (
          <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Progress</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead>Monthly</TableHead>
                  <TableHead>Required / Status</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead aria-label="Actions" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading
                  ? Array.from({ length: 6 }).map((_, i) => (
                      <SkeletonRow key={`goals-skeleton-${i}`} cols={9} />
                    ))
                  : goals.map((row) => {
                  if (editId === row.id) {
                    return (
                      <TableRow key={row.id}>
                        <TableCell colSpan={9}>
                          <form onSubmit={saveEdit}>
                            <GoalFormFields
                              form={editForm}
                              setForm={setEditForm}
                              accountOptions={accountOptions}
                              idPrefix={`goal-edit-${row.id}`}
                              showStatus
                              showErrors={editAttempted}
                            />
                            <div className="mb-3 flex flex-wrap items-center gap-3">
                              <Button
                                type="submit"
                                size="sm"
                                disabled={editSaving}
                              >
                                Save
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={cancelEdit}
                                disabled={editSaving}
                              >
                                Cancel
                              </Button>
                            </div>
                          </form>
                        </TableCell>
                      </TableRow>
                    )
                  }
                  const projection = projections[row.id]
                  const progress = projection?.progressPercent ?? 0
                  const forecast = projection?.forecast
                  const forecastStatus = forecast?.status
                  return (
                    <TableRow key={row.id}>
                      <TableCell>
                        <div className="font-medium">{row.name}</div>
                        {row.notes ? (
                          <div className="text-xs text-muted-foreground">{row.notes}</div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <div
                            className="h-2 w-32 overflow-hidden rounded-full bg-muted"
                            role="progressbar"
                            aria-valuenow={Math.round(progress)}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-label={`Progress for ${row.name}`}
                          >
                            <div
                              className="h-full bg-success"
                              style={{ width: `${progress}%` }}
                            />
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {safeNum(row.currentAmount) !== null
                              ? formatMoney(safeNum(row.currentAmount)!, row.currency)
                              : <em className="text-muted-foreground">(unset)</em>}
                            {' / '}
                            {safeNum(row.targetAmount) !== null
                              ? formatMoney(safeNum(row.targetAmount)!, row.currency)
                              : <em className="text-muted-foreground">(unset)</em>}
                            {' '}
                            ({progress.toFixed(0)}%)
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {safeNum(row.targetAmount) !== null
                          ? formatMoney(safeNum(row.targetAmount)!, row.currency)
                          : <em className="text-muted-foreground">(unset)</em>}
                      </TableCell>
                      <TableCell>{row.targetDate ?? '—'}</TableCell>
                      <TableCell>
                        {row.monthlyContribution == null
                          ? '—'
                          : safeNum(row.monthlyContribution) !== null
                            ? formatMoney(safeNum(row.monthlyContribution)!, row.currency)
                            : <em className="text-muted-foreground">(unset)</em>}
                      </TableCell>
                      <TableCell>
                        {/* Forecast-grounded (#653): "Need $X/mo to stay on
                            track" derives from the real forecast, not the typed
                            contribution. Falls back to "—" when the projection
                            fetch failed (no projection on this row). */}
                        {forecast?.currencyMismatch ? (
                          <div className="text-xs text-muted-foreground">
                            Goal currency ({row.currency}) differs from forecast (
                            {forecast.currency}).
                          </div>
                        ) : forecast?.requiredMonthlyContribution ? (
                          <div className="text-xs">
                            <div>
                              Need{' '}
                              {safeNum(forecast.requiredMonthlyContribution) !== null
                                ? formatMoney(safeNum(forecast.requiredMonthlyContribution)!, row.currency)
                                : <em className="text-muted-foreground">(unset)</em>}
                              /mo
                              {forecastStatus === 'off_track'
                                ? safeNum(forecast.monthlyFreeCash) !== null
                                  ? ` — forecast covers ${formatMoney(safeNum(forecast.monthlyFreeCash)!, forecast.currency)}/mo`
                                  : null
                                : ' to stay on track'}
                            </div>
                            {forecast.projectedCompletionDate ? (
                              <div className="text-sm leading-6 text-muted-foreground">
                                Finish ~{forecast.projectedCompletionDate}
                              </div>
                            ) : null}
                          </div>
                        ) : forecast?.projectedCompletionDate ? (
                          <div className="text-xs text-muted-foreground">
                            Finish ~{forecast.projectedCompletionDate}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {row.linkedAccountId == null
                          ? '—'
                          : accountNamesById.get(row.linkedAccountId) ??
                            `#${row.linkedAccountId}`}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <Badge className={STATUS_BADGE[row.status]}>
                            {statusLabel(row.status)}
                          </Badge>
                          {/* Forecast-grounded badge (#653): exactly one badge
                              from the literal-class FORECAST_BADGE table. When
                              the projection fetch failed (no `forecast`), only
                              the status badge above renders. */}
                          {row.status === 'active' && forecastStatus ? (
                            <Badge className={FORECAST_BADGE[forecastStatus]}>
                              {FORECAST_LABEL[forecastStatus]}
                            </Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="mb-3 flex flex-wrap items-center gap-3">
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={() => openEdit(row)}
                          >
                            <Icon name="pencil" aria-hidden="true" />
                            Edit
                          </Button>
                          {row.status !== 'completed' ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => void archiveGoal(row)}
                              title="Mark as completed (archive — kept in DB)"
                            >
                              Archive
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            onClick={() => void deleteGoal(row)}
                          >
                            <Icon name="trash" aria-hidden="true" />
                            Delete
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                  })}
              </TableBody>
            </Table>
        )}

        <form onSubmit={createGoal}>
          <h3 className="mt-4">Add a goal</h3>
          <GoalFormFields
            form={form}
            setForm={setForm}
            accountOptions={accountOptions}
            idPrefix="goal-new"
            showStatus={false}
            showErrors={createAttempted}
          />
          <Button type="submit" disabled={submitting}>
            <Icon name="plus" aria-hidden="true" />
            Add goal
          </Button>
        </form>
      </Card>
      {confirm.dialog}
    </>
  )
}

type GoalFormFieldsProps = {
  form: FormState
  setForm: (updater: (prev: FormState) => FormState) => void
  accountOptions: Account[]
  idPrefix: string
  showStatus: boolean
  /** When true, surface inline validation errors (set after a submit attempt). */
  showErrors?: boolean
}

function GoalFormFields({
  form,
  setForm,
  accountOptions,
  idPrefix,
  showStatus,
  showErrors = false,
}: GoalFormFieldsProps) {
  const targetAmountError = showErrors
    ? negativeAmountError(form.targetAmount)
    : ''
  const contributionError = showErrors
    ? negativeAmountError(form.monthlyContribution)
    : ''
  return (
    <Grid minItemWidth={180} gap="md" fill className="mb-3">
      <Label htmlFor={`${idPrefix}-name`}>
        Name
        <Input
          id={`${idPrefix}-name`}
          value={form.name}
          onChange={(e) =>
            setForm((prev) => ({ ...prev, name: e.target.value }))
          }
          required
          maxLength={255}
          placeholder="Emergency fund, Vacation 2027, Annual insurance…"
        />
      </Label>
      <Label htmlFor={`${idPrefix}-target-amount`}>
        Target amount
        <Input
          id={`${idPrefix}-target-amount`}
          type="number"
          step="0.01"
          min="0"
          value={form.targetAmount}
          onChange={(e) =>
            setForm((prev) => ({ ...prev, targetAmount: e.target.value }))
          }
          required
          placeholder="5000.00"
          aria-invalid={targetAmountError ? 'true' : undefined}
          aria-describedby={
            targetAmountError ? `${idPrefix}-target-amount-error` : undefined
          }
        />
        {targetAmountError && (
          <p
            id={`${idPrefix}-target-amount-error`}
            className="text-sm text-destructive mt-1"
          >
            {targetAmountError}
          </p>
        )}
      </Label>
      <Label htmlFor={`${idPrefix}-current-amount`}>
        Current amount
        <Input
          id={`${idPrefix}-current-amount`}
          type="number"
          step="0.01"
          min="0"
          value={form.currentAmount}
          onChange={(e) =>
            setForm((prev) => ({ ...prev, currentAmount: e.target.value }))
          }
          placeholder="0"
        />
      </Label>
      <Label htmlFor={`${idPrefix}-currency`}>
        Currency
        <Input
          id={`${idPrefix}-currency`}
          value={form.currency}
          onChange={(e) =>
            setForm((prev) => ({
              ...prev,
              currency: e.target.value.toUpperCase().slice(0, 3),
            }))
          }
          required
          maxLength={3}
          autoComplete="off"
        />
      </Label>
      <Label htmlFor={`${idPrefix}-target-date`}>
        Target date (optional)
        <Input
          id={`${idPrefix}-target-date`}
          type="date"
          value={form.targetDate}
          onChange={(e) =>
            setForm((prev) => ({ ...prev, targetDate: e.target.value }))
          }
        />
      </Label>
      <Label htmlFor={`${idPrefix}-monthly-contribution`}>
        Monthly contribution (optional)
        <Input
          id={`${idPrefix}-monthly-contribution`}
          type="number"
          step="0.01"
          min="0"
          value={form.monthlyContribution}
          onChange={(e) =>
            setForm((prev) => ({
              ...prev,
              monthlyContribution: e.target.value,
            }))
          }
          placeholder="0"
          aria-invalid={contributionError ? 'true' : undefined}
          aria-describedby={
            contributionError
              ? `${idPrefix}-monthly-contribution-error`
              : undefined
          }
        />
        {contributionError && (
          <p
            id={`${idPrefix}-monthly-contribution-error`}
            className="text-sm text-destructive mt-1"
          >
            {contributionError}
          </p>
        )}
      </Label>
      <Label htmlFor={`${idPrefix}-account`}>
        Linked account (optional)
        <NativeSelect
          id={`${idPrefix}-account`}
          value={form.linkedAccountId}
          onChange={(e) =>
            setForm((prev) => ({ ...prev, linkedAccountId: e.target.value }))
          }
        >
          <option value="">Unassigned</option>
          {accountOptions.map((a) => (
            <option key={a.id} value={String(a.id)}>
              {a.name}
              {a.defaultCurrency ? ` (${a.defaultCurrency})` : ''}
            </option>
          ))}
        </NativeSelect>
      </Label>
      <Label htmlFor={`${idPrefix}-priority`}>
        Priority
        <Input
          id={`${idPrefix}-priority`}
          type="number"
          step="1"
          value={form.priority}
          onChange={(e) =>
            setForm((prev) => ({ ...prev, priority: e.target.value }))
          }
        />
      </Label>
      {showStatus ? (
        <Label htmlFor={`${idPrefix}-status`}>
          Status
          <NativeSelect
            id={`${idPrefix}-status`}
            value={form.status}
            onChange={(e) =>
              setForm((prev) => ({
                ...prev,
                status: e.target.value as FinancialGoalStatus,
              }))
            }
          >
            {GOAL_STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </NativeSelect>
        </Label>
      ) : null}
      <Label htmlFor={`${idPrefix}-notes`}>
        Notes (optional)
        <Textarea
          id={`${idPrefix}-notes`}
          value={form.notes}
          onChange={(e) =>
            setForm((prev) => ({ ...prev, notes: e.target.value }))
          }
          rows={2}
          maxLength={4096}
        />
      </Label>
    </Grid>
  )
}
