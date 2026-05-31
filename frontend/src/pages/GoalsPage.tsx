import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { safeNum } from '@/lib/num'
import { Edit3, Plus, Target, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useConfirm } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { PageHeader } from '@/components/ui/page-header'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/toast'
import { deleteReq, getJson, postJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import type {
  Account,
  FinancialGoal,
  FinancialGoalInput,
  FinancialGoalPatch,
  FinancialGoalsResponse,
  FinancialGoalStatus,
  GoalProjectionResponse,
  GoalProjectionStatus,
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
  active: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100',
  paused: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100',
  completed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100',
}

const PROJECTION_BADGE: Record<GoalProjectionStatus, string> = {
  completed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100',
  on_track: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100',
  ahead: 'bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-100',
  behind: 'bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-100',
  unfunded: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100',
  active: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-100',
}

const PROJECTION_LABEL: Record<GoalProjectionStatus, string> = {
  completed: 'Completed',
  on_track: 'On track',
  ahead: 'Ahead',
  behind: 'Behind',
  unfunded: 'No contribution',
  active: 'Active',
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

  const [goals, setGoals] = useState<FinancialGoal[]>([])
  const [projections, setProjections] = useState<Record<number, GoalProjectionResponse>>({})
  const [accounts, setAccounts] = useState<Account[]>([])
  const [form, setForm] = useState<FormState>(emptyForm())
  const [submitting, setSubmitting] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [editForm, setEditForm] = useState<FormState>(emptyForm())
  const [editSaving, setEditSaving] = useState(false)
  const [statusFilter, setStatusFilter] = useState<FinancialGoalStatus | ''>('active')

  const loadGoals = useCallback(async () => {
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
      showToast({ title: 'Goal updated', variant: 'success' })
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
      <Card className="accountsFormCard">
        <div className="accountsCardHeader">
          <div>
            <h2 className="flex items-center gap-2">
              <Target aria-hidden="true" className="h-5 w-5" />
              Your goals
            </h2>
            <p className="muted">
              {goals.length === 0
                ? 'Add a goal below to start tracking progress.'
                : `${goals.length} goal${goals.length === 1 ? '' : 's'} shown.`}
            </p>
          </div>
          <div>
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
          </div>
        </div>
        {goals.length === 0 ? (
          <EmptyState
            title="No goals yet."
            description="Add a target below — emergency fund, sinking fund, or upcoming expense."
          />
        ) : (
          <div className="tableWrap">
            <Table className="table">
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
                {goals.map((row) => {
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
                            />
                            <div className="row">
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
                  const projStatus = projection?.status ?? 'active'
                  return (
                    <TableRow key={row.id}>
                      <TableCell>
                        <div className="font-medium">{row.name}</div>
                        {row.notes ? (
                          <div className="muted text-xs">{row.notes}</div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <div
                            className="h-2 w-32 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700"
                            role="progressbar"
                            aria-valuenow={Math.round(progress)}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-label={`Progress for ${row.name}`}
                          >
                            <div
                              className="h-full bg-emerald-500 dark:bg-emerald-400"
                              style={{ width: `${progress}%` }}
                            />
                          </div>
                          <div className="muted text-xs">
                            {safeNum(row.currentAmount) !== null ? formatMoney(safeNum(row.currentAmount)!, row.currency) : <span className="italic text-muted-foreground">(unset)</span>}
                            {' / '}
                            {safeNum(row.targetAmount) !== null ? formatMoney(safeNum(row.targetAmount)!, row.currency) : <span className="italic text-muted-foreground">(unset)</span>}
                            {' '}
                            ({progress.toFixed(0)}%)
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {safeNum(row.targetAmount) !== null ? formatMoney(safeNum(row.targetAmount)!, row.currency) : <span className="italic text-muted-foreground">(unset)</span>}
                      </TableCell>
                      <TableCell>{row.targetDate ?? '—'}</TableCell>
                      <TableCell>
                        {row.monthlyContribution == null
                          ? '—'
                          : safeNum(row.monthlyContribution) !== null
                            ? formatMoney(safeNum(row.monthlyContribution)!, row.currency)
                            : <span className="italic text-muted-foreground">(unset)</span>}
                      </TableCell>
                      <TableCell>
                        {projection?.requiredMonthlyContribution ? (
                          <div className="text-xs">
                            <div>
                              Need{' '}
                              {safeNum(projection.requiredMonthlyContribution) !== null ? formatMoney(safeNum(projection.requiredMonthlyContribution)!, row.currency) : <span className="italic text-muted-foreground">(unset)</span>}
                              /mo
                            </div>
                            {projection.projectedCompletionDate ? (
                              <div className="muted">
                                Finish ~{projection.projectedCompletionDate}
                              </div>
                            ) : null}
                          </div>
                        ) : projection?.projectedCompletionDate ? (
                          <div className="muted text-xs">
                            Finish ~{projection.projectedCompletionDate}
                          </div>
                        ) : (
                          <span className="muted text-xs">—</span>
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
                          {row.status === 'active' && projection ? (
                            <Badge className={PROJECTION_BADGE[projStatus]}>
                              {PROJECTION_LABEL[projStatus]}
                            </Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="row">
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={() => openEdit(row)}
                          >
                            <Edit3 aria-hidden="true" />
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

        <form onSubmit={createGoal}>
          <h3 className="mt-4">Add a goal</h3>
          <GoalFormFields
            form={form}
            setForm={setForm}
            accountOptions={accountOptions}
            idPrefix="goal-new"
            showStatus={false}
          />
          <Button type="submit" disabled={submitting}>
            <Plus aria-hidden="true" />
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
}

function GoalFormFields({
  form,
  setForm,
  accountOptions,
  idPrefix,
  showStatus,
}: GoalFormFieldsProps) {
  return (
    <div className="formGrid">
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
        />
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
        />
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
    </div>
  )
}
