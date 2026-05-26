import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
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
  FinancialGoalStatus,
  FinancialGoalsResponse,
  GoalOnTrackStatus,
  GoalProjection,
} from '../types/api'

const DEFAULT_CURRENCY = 'CAD'

/**
 * Wrapper for `fetch` PUT against /api/goals/:id. The shared `lib/api.ts`
 * helper set exposes POST/PATCH/DELETE but not PUT, so we inline a tiny
 * client here. Mirrors the credential and error-handling contract of the
 * shared helpers — and mirrors the same one in PlannedEventsPage.
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

const STATUS_OPTIONS: Array<{ value: FinancialGoalStatus; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'completed', label: 'Completed (archived)' },
]

// Tailwind v4 JIT requires literal class names — look up status colours via
// a lookup table so the bundler keeps them.
const STATUS_BADGE: Record<FinancialGoalStatus, string> = {
  active: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100',
  paused: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100',
  completed:
    'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100',
}

const PROJECTION_BADGE: Record<GoalOnTrackStatus, string> = {
  ahead: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100',
  on_track: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100',
  behind: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100',
  overdue: 'bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-100',
  no_deadline: 'bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100',
  completed:
    'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100',
  paused: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100',
}

const PROJECTION_LABEL: Record<GoalOnTrackStatus, string> = {
  ahead: 'Ahead',
  on_track: 'On track',
  behind: 'Behind',
  overdue: 'Overdue',
  no_deadline: 'No deadline',
  completed: 'Completed',
  paused: 'Paused',
}

function statusLabel(status: FinancialGoalStatus): string {
  return STATUS_OPTIONS.find((o) => o.value === status)?.label ?? status
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
    currentAmount: '0',
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
  const currency = form.currency.trim().toUpperCase()
  if (currency.length !== 3) return null
  const currentAmount = Number(form.currentAmount || '0')
  if (!Number.isFinite(currentAmount) || currentAmount < 0) return null
  const priority = Number(form.priority || '0')
  if (!Number.isInteger(priority) || priority < 0) return null
  const monthlyContribution = form.monthlyContribution.trim()
    ? Number(form.monthlyContribution)
    : null
  if (
    monthlyContribution != null &&
    (!Number.isFinite(monthlyContribution) || monthlyContribution < 0)
  )
    return null
  const targetDate = form.targetDate.trim()
  if (targetDate && !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) return null
  const linkedAccountId = form.linkedAccountId
    ? Number.parseInt(form.linkedAccountId, 10)
    : null
  if (linkedAccountId != null && !Number.isInteger(linkedAccountId)) return null
  const notes = form.notes.trim()
  return {
    name,
    targetAmount,
    currentAmount,
    currency,
    targetDate: targetDate ? targetDate : null,
    monthlyContribution,
    linkedAccountId,
    priority,
    status: form.status,
    notes: notes ? notes : null,
  }
}

export function GoalsPage() {
  const { showToast } = useToast()
  const confirm = useConfirm()

  const [goals, setGoals] = useState<FinancialGoal[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [form, setForm] = useState<FormState>(emptyForm())
  const [submitting, setSubmitting] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [editForm, setEditForm] = useState<FormState>(emptyForm())
  const [editSaving, setEditSaving] = useState(false)
  // Default to hiding completed goals (they're archived, not deleted, so the
  // UI keeps them out of the way without losing them).
  const [statusFilter, setStatusFilter] = useState<FinancialGoalStatus | 'all'>(
    'active',
  )
  const [projections, setProjections] = useState<Record<number, GoalProjection>>(
    {},
  )

  const loadGoals = useCallback(async () => {
    try {
      const path =
        statusFilter === 'all'
          ? '/api/goals'
          : `/api/goals?status=${encodeURIComponent(statusFilter)}`
      const resp = await getJson<FinancialGoalsResponse>(path)
      setGoals(resp.data)
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

  // Fetch projections for every visible goal. Re-runs when the visible set
  // changes; cheap enough at small N to avoid an explicit cache.
  useEffect(() => {
    let cancelled = false
    async function loadProjections() {
      const entries = await Promise.all(
        goals.map(async (goal) => {
          try {
            const p = await getJson<GoalProjection>(
              `/api/goals/${goal.id}/projection`,
            )
            return [goal.id, p] as const
          } catch {
            return null
          }
        }),
      )
      if (cancelled) return
      const map: Record<number, GoalProjection> = {}
      for (const e of entries) {
        if (e) map[e[0]] = e[1]
      }
      setProjections(map)
    }
    void loadProjections()
    return () => {
      cancelled = true
    }
  }, [goals])

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
          'Fill in name, a positive target amount, and a 3-letter currency.',
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
    const input = buildInput(editForm)
    if (!input) {
      showToast({
        title: 'Could not save goal',
        description:
          'Fill in name, a positive target amount, and a 3-letter currency.',
        variant: 'destructive',
      })
      return
    }
    setEditSaving(true)
    try {
      await putGoal(editId, input)
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
      description: `${row.name} will be permanently removed. To stop tracking it without losing it, archive (mark "completed") instead.`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await deleteReq(`/api/goals/${row.id}`)
      await loadGoals()
      showToast({ title: 'Goal removed', variant: 'success' })
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Could not delete goal'
      showToast({
        title: 'Could not delete goal',
        description: message,
        variant: 'destructive',
      })
    }
  }

  return (
    <>
      <PageHeader
        title="Goals"
        description="Savings targets and sinking funds. Track progress, required monthly contributions, and on-track / behind / ahead status."
      />
      <Card className="accountsFormCard">
        <div className="accountsCardHeader">
          <div>
            <h2 className="flex items-center gap-2">
              <Target aria-hidden="true" className="h-5 w-5" />
              Goals
            </h2>
            <p className="muted">
              {goals.length === 0
                ? statusFilter === 'all'
                  ? 'Add a goal below to start tracking a savings target.'
                  : `No ${statusFilter === 'completed' ? 'completed' : statusFilter} goals.`
                : `${goals.length} goal${goals.length === 1 ? '' : 's'} on file.`}
            </p>
          </div>
          <div>
            <Label htmlFor="goals-status-filter" className="text-sm">
              Status
              <NativeSelect
                id="goals-status-filter"
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(
                    e.target.value as FinancialGoalStatus | 'all',
                  )
                }
              >
                <option value="all">All</option>
                {STATUS_OPTIONS.map((opt) => (
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
            description="Add an emergency fund, vacation, down payment, or any savings target."
          />
        ) : (
          <div className="tableWrap">
            <Table className="table">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Progress</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Current</TableHead>
                  <TableHead>Target date</TableHead>
                  <TableHead>Required / mo</TableHead>
                  <TableHead>Pace</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead aria-label="Actions" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {goals.map((row) => {
                  if (editId === row.id) {
                    return (
                      <TableRow key={row.id}>
                        <TableCell colSpan={10}>
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
                  const proj = projections[row.id]
                  return (
                    <TableRow key={row.id}>
                      <TableCell>
                        <div className="font-medium">{row.name}</div>
                        {row.notes ? (
                          <div className="muted text-xs">{row.notes}</div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        {proj
                          ? `${Math.round(proj.progressPercent)}%`
                          : '—'}
                      </TableCell>
                      <TableCell>
                        {formatMoney(Number(row.targetAmount), row.currency)}
                      </TableCell>
                      <TableCell>
                        {formatMoney(Number(row.currentAmount), row.currency)}
                      </TableCell>
                      <TableCell>{row.targetDate ?? '—'}</TableCell>
                      <TableCell>
                        {proj?.requiredMonthlyContribution
                          ? formatMoney(
                              Number(proj.requiredMonthlyContribution),
                              row.currency,
                            )
                          : '—'}
                      </TableCell>
                      <TableCell>
                        {proj ? (
                          <Badge
                            className={PROJECTION_BADGE[proj.onTrackStatus]}
                          >
                            {PROJECTION_LABEL[proj.onTrackStatus]}
                          </Badge>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge className={STATUS_BADGE[row.status]}>
                          {statusLabel(row.status)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {row.linkedAccountId == null
                          ? '—'
                          : accountNamesById.get(row.linkedAccountId) ??
                            `#${row.linkedAccountId}`}
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
          <h3 className="mt-4">Add goal</h3>
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
          placeholder="Emergency fund, Vacation, Down payment…"
        />
      </Label>
      <Label htmlFor={`${idPrefix}-target`}>
        Target amount
        <Input
          id={`${idPrefix}-target`}
          type="number"
          step="0.01"
          min="0"
          value={form.targetAmount}
          onChange={(e) =>
            setForm((prev) => ({ ...prev, targetAmount: e.target.value }))
          }
          required
          placeholder="0.00"
        />
      </Label>
      <Label htmlFor={`${idPrefix}-current`}>
        Current amount
        <Input
          id={`${idPrefix}-current`}
          type="number"
          step="0.01"
          min="0"
          value={form.currentAmount}
          onChange={(e) =>
            setForm((prev) => ({ ...prev, currentAmount: e.target.value }))
          }
          placeholder="0.00"
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
      <Label htmlFor={`${idPrefix}-monthly`}>
        Monthly contribution (optional)
        <Input
          id={`${idPrefix}-monthly`}
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
          placeholder="0.00"
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
          min="0"
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
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </NativeSelect>
        </Label>
      ) : null}
      <Label htmlFor={`${idPrefix}-notes`}>
        Notes
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
