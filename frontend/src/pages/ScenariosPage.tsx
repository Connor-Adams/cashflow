/**
 * Financial scenario planner (issue #213).
 *
 * Lets Connor model hypothetical financial changes without touching real data:
 *   "What if I buy a car?"
 *   "What if income drops 30%?"
 *   "What if I save $2,000/month?"
 *
 * UI structure:
 *   - Header with "New scenario" button
 *   - Card list of saved scenarios with delta summary chips
 *   - Drawer-style editor for creating/editing scenarios
 *   - Side-by-side comparison panel: baseline vs scenario closing balance,
 *     lowest balance, and a dual-sparkline (inline SVG, no lib needed)
 *
 * NOTE: debt-payoff assumption type is intentionally omitted — the debt
 * planner (#202) is still open. A "TODO: add debt-payoff when #202 ships"
 * comment is left in the form.
 *
 * NOTE on opportunity cost (#252): the scenario result exposes the daily
 * forecast series, which is exactly the data needed to compute the future
 * value / opportunity cost of a lump-sum change. Issue #252 can be resolved
 * without a backend schema change — just add a FV helper to this UI.
 */
import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { GitCompare } from 'lucide-react'
import { Alert, Icon } from '@connor-adams/designsystem'
import { Badge } from '@connor-adams/designsystem'
import { Button } from '@connor-adams/designsystem'
import { Card } from '@connor-adams/designsystem'
import { EmptyState } from '@connor-adams/designsystem'
import { Input } from '@connor-adams/designsystem'
import { Label } from '@connor-adams/designsystem'
import { NativeSelect } from '@connor-adams/designsystem'
import { PageHeader } from '@/components/ui/page-header'
import { SkeletonRow } from '@/lib/ds-extras'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@connor-adams/designsystem'
import { useToast } from '@/components/ui/toast'
import { deleteReq, getJson, patchJson, postJson } from '../lib/api'
import { todayDateInputValue } from '../lib/dateInput'
import { formatMoney } from '../lib/formatMoney'
import type {
  AssumptionRecurrence,
  AssumptionType,
  CreateScenarioBody,
  FinancialScenario,
  FinancialScenarioListResponse,
  ScenarioAssumption,
} from '../types/financialScenario'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ASSUMPTION_TYPE_LABELS: Record<AssumptionType, string> = {
  income: 'Income',
  expense: 'Expense',
  savings: 'Savings',
  one_off: 'One-off',
}

const RECURRENCE_LABELS: Record<AssumptionRecurrence, string> = {
  weekly: 'Weekly',
  biweekly: 'Biweekly',
  monthly: 'Monthly',
}

// Tailwind variant lookup tables (literal class names — JIT must see them).
const DELTA_POSITIVE_CLASS = 'text-positive'
const DELTA_NEGATIVE_CLASS = 'text-destructive'
const DELTA_NEUTRAL_CLASS = 'text-muted-foreground'

function deltaClass(delta: number): string {
  if (delta > 0) return DELTA_POSITIVE_CLASS
  if (delta < 0) return DELTA_NEGATIVE_CLASS
  return DELTA_NEUTRAL_CLASS
}

// ---------------------------------------------------------------------------
// Sparkline (inline SVG, no external lib)
// ---------------------------------------------------------------------------

type SparklineProps = {
  points: { date: string; balance: number }[]
  /** Color of the line — a Tailwind stroke class or hex. */
  color?: string
  width?: number
  height?: number
  'aria-label'?: string
}

function Sparkline({
  points,
  color = 'var(--chart-scenario)',
  width = 120,
  height = 36,
  'aria-label': ariaLabel,
}: SparklineProps) {
  if (!points.length) return null
  const values = points.map((p) => p.balance)
  const minV = Math.min(...values)
  const maxV = Math.max(...values)
  const range = maxV - minV || 1
  const xs = points.map((_, i) => (i / (points.length - 1 || 1)) * width)
  const ys = values.map((v) => height - ((v - minV) / range) * (height - 4) - 2)
  const d = xs.map((x, i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${ys[i].toFixed(1)}`).join(' ')
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-label={ariaLabel}
      role="img"
    >
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Empty assumption row builder
// ---------------------------------------------------------------------------

function emptyAssumption(): ScenarioAssumption {
  return {
    label: '',
    type: 'expense',
    amount: 0,
    startDate: todayDateInputValue(),
    endDate: null,
    recurrence: null,
    direction: 'out',
  }
}

// ---------------------------------------------------------------------------
// Assumption form row
// ---------------------------------------------------------------------------

function AssumptionRow({
  assumption,
  index,
  onChange,
  onRemove,
}: {
  assumption: ScenarioAssumption
  index: number
  onChange: (i: number, updated: ScenarioAssumption) => void
  onRemove: (i: number) => void
}) {
  function set<K extends keyof ScenarioAssumption>(k: K, v: ScenarioAssumption[K]) {
    onChange(index, { ...assumption, [k]: v })
  }

  return (
    <div className="flex flex-col gap-2 rounded border border-border p-3">
      <div className="flex flex-wrap gap-2">
        {/* Label */}
        <div className="flex-1 min-w-[160px]">
          <Label htmlFor={`label-${index}`} className="sr-only">
            Description
          </Label>
          <Input
            id={`label-${index}`}
            placeholder="Description"
            value={assumption.label}
            onChange={(e) => set('label', e.target.value)}
          />
        </div>
        {/* Type */}
        <NativeSelect
          aria-label="Type"
          value={assumption.type}
          onChange={(e) => set('type', e.target.value as AssumptionType)}
          className="w-28"
        >
          {(Object.keys(ASSUMPTION_TYPE_LABELS) as AssumptionType[]).map((t) => (
            <option key={t} value={t}>
              {ASSUMPTION_TYPE_LABELS[t]}
            </option>
          ))}
        </NativeSelect>
        {/* Amount */}
        <div className="w-28">
          <Label htmlFor={`amount-${index}`} className="sr-only">
            Amount
          </Label>
          <Input
            id={`amount-${index}`}
            type="number"
            min="0"
            step="0.01"
            placeholder="Amount"
            value={assumption.amount === 0 ? '' : String(assumption.amount)}
            onChange={(e) => set('amount', Number(e.target.value) || 0)}
          />
        </div>
        {/* Direction — only for one_off */}
        {assumption.type === 'one_off' && (
          <NativeSelect
            aria-label="Direction"
            value={assumption.direction ?? 'out'}
            onChange={(e) => set('direction', e.target.value as 'in' | 'out')}
            className="w-20"
          >
            <option value="out">Out</option>
            <option value="in">In</option>
          </NativeSelect>
        )}
        {/* Remove */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onRemove(index)}
          aria-label={`Remove assumption ${index + 1}`}
        >
          <Icon name="trash" className="size-4" />
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {/* Start date */}
        <div>
          <Label htmlFor={`start-${index}`} className="text-xs text-muted-foreground">
            Start date
          </Label>
          <Input
            id={`start-${index}`}
            type="date"
            value={assumption.startDate}
            onChange={(e) => set('startDate', e.target.value)}
            className="w-36"
          />
        </div>
        {/* Recurrence */}
        <div>
          <Label htmlFor={`recur-${index}`} className="text-xs text-muted-foreground">
            Recurrence
          </Label>
          <NativeSelect
            id={`recur-${index}`}
            value={assumption.recurrence ?? ''}
            onChange={(e) =>
              set('recurrence', (e.target.value as AssumptionRecurrence) || null)
            }
            className="w-28"
          >
            <option value="">One-time</option>
            {(Object.keys(RECURRENCE_LABELS) as AssumptionRecurrence[]).map((r) => (
              <option key={r} value={r}>
                {RECURRENCE_LABELS[r]}
              </option>
            ))}
          </NativeSelect>
        </div>
        {/* End date — only for recurring */}
        {assumption.recurrence && (
          <div>
            <Label htmlFor={`end-${index}`} className="text-xs text-muted-foreground">
              End date (optional)
            </Label>
            <Input
              id={`end-${index}`}
              type="date"
              value={assumption.endDate ?? ''}
              onChange={(e) => set('endDate', e.target.value || null)}
              className="w-36"
            />
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Scenario editor drawer
// ---------------------------------------------------------------------------

type EditorProps = {
  scenario: FinancialScenario | null // null = new
  onClose: () => void
  onSaved: (s: FinancialScenario) => void
}

function ScenarioEditor({ scenario, onClose, onSaved }: EditorProps) {
  const { showToast } = useToast()
  const [name, setName] = useState(scenario?.name ?? '')
  const [baselineDays, setBaselineDays] = useState<30 | 60 | 90>(
    scenario?.assumptionsJson.baselineDays ?? 30,
  )
  const [overrides, setOverrides] = useState<ScenarioAssumption[]>(
    scenario?.assumptionsJson.overrides ?? [],
  )
  const [saving, setSaving] = useState(false)

  function addOverride() {
    setOverrides((prev) => [...prev, emptyAssumption()])
  }

  function updateOverride(i: number, updated: ScenarioAssumption) {
    setOverrides((prev) => prev.map((o, idx) => (idx === i ? updated : o)))
  }

  function removeOverride(i: number) {
    setOverrides((prev) => prev.filter((_, idx) => idx !== i))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const body: CreateScenarioBody = { name, overrides, baselineDays }
      let saved: FinancialScenario
      if (scenario) {
        saved = await patchJson<FinancialScenario>(`/api/financial-scenarios/${scenario.id}`, body)
      } else {
        saved = await postJson<FinancialScenario>('/api/financial-scenarios', body)
      }
      onSaved(saved)
      showToast({
        title: scenario ? 'Scenario updated' : 'Scenario created',
        variant: 'success',
      })
    } catch (e) {
      showToast({
        title: e instanceof Error ? e.message : 'Failed to save',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={scenario ? `Edit ${scenario.name}` : 'New scenario'}
      className="fixed inset-0 z-50 flex items-start justify-end"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" aria-hidden="true" onClick={onClose} />
      {/* Drawer panel */}
      <div className="relative z-10 flex h-full w-full max-w-lg flex-col bg-background shadow-xl overflow-y-auto">
        <div className="flex items-center justify-between border-b border-border p-4">
          <h2 className="text-lg font-semibold">
            {scenario ? 'Edit scenario' : 'New scenario'}
          </h2>
          <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </div>
        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-1 flex-col gap-4 p-4">
          {/* Name */}
          <div>
            <Label htmlFor="scenario-name">Name</Label>
            <Input
              id="scenario-name"
              required
              placeholder="e.g. What if I buy a car?"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {/* Forecast window */}
          <div>
            <Label htmlFor="baseline-days">Forecast window</Label>
            <NativeSelect
              id="baseline-days"
              value={baselineDays}
              onChange={(e) => setBaselineDays(Number(e.target.value) as 30 | 60 | 90)}
            >
              <option value={30}>30 days</option>
              <option value={60}>60 days</option>
              <option value={90}>90 days</option>
            </NativeSelect>
          </div>

          {/* Assumptions */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <Label>Assumptions</Label>
              <Button type="button" variant="outline" size="sm" onClick={addOverride}>
                <Icon name="plus" className="size-3" /> Add
              </Button>
            </div>
            {overrides.length === 0 ? (
              <p className="text-sm text-center py-4 text-muted-foreground">
                No assumptions yet — add one to model a hypothetical change.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {overrides.map((o, i) => (
                  <AssumptionRow
                    key={i}
                    assumption={o}
                    index={i}
                    onChange={updateOverride}
                    onRemove={removeOverride}
                  />
                ))}
              </div>
            )}
            {/* NOTE: debt-payoff assumption type is not supported yet — it
                depends on the debt planner (issue #202). */}
          </div>

          <div className="mt-auto flex justify-end gap-2 pt-4 border-t border-border">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : scenario ? 'Save changes' : 'Create scenario'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Delta summary display
// ---------------------------------------------------------------------------

function DeltaBadge({ delta, currency }: { delta: number; currency: string }) {
  if (delta === 0) return <span className={DELTA_NEUTRAL_CLASS}>—</span>
  return (
    <span className={`flex items-center gap-1 font-medium ${deltaClass(delta)}`}>
      {delta > 0 ? (
        <Icon name="trending-up" className="size-3" aria-hidden="true" />
      ) : (
        <Icon name="trending-down" className="size-3" aria-hidden="true" />
      )}
      {delta > 0 ? '+' : ''}
      {formatMoney(delta, currency)}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Comparison panel (expanded view for a single scenario)
// ---------------------------------------------------------------------------

function ComparisonPanel({
  scenario,
  onClose,
  onRecompute,
}: {
  scenario: FinancialScenario
  onClose: () => void
  onRecompute: (s: FinancialScenario) => void
}) {
  const { showToast } = useToast()
  const [recomputing, setRecomputing] = useState(false)
  const rj = scenario.resultJson
  const currency = rj?.currency ?? 'CAD'

  async function handleRecompute() {
    setRecomputing(true)
    try {
      const updated = await postJson<FinancialScenario>(
        `/api/financial-scenarios/${scenario.id}/recompute`,
      )
      onRecompute(updated)
      showToast({ title: 'Forecast recomputed', variant: 'success' })
    } catch (e) {
      showToast({
        title: e instanceof Error ? e.message : 'Recompute failed',
        variant: 'destructive',
      })
    } finally {
      setRecomputing(false)
    }
  }

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold flex items-center gap-2">
          <GitCompare className="size-4" aria-hidden="true" />
          Comparison
        </h3>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleRecompute()}
            disabled={recomputing}
            title="Recompute with today's actual balances and planned events"
          >
            <Icon name="refresh-cw" className={`size-3 ${recomputing ? 'animate-spin' : ''}`} />
            {recomputing ? 'Computing…' : 'Recompute'}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>

      {!rj ? (
        <Card className="p-4">
          <p className="text-sm text-center text-muted-foreground">
            No results yet — click Recompute to run the forecast.
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* Baseline card */}
          <Card className="p-4">
            <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Baseline</div>
            <div className="mb-3">
              <div className="text-xs text-muted-foreground">Projected closing</div>
              <div className="text-xl font-bold">
                {formatMoney(rj.baseline.closing, currency)}
              </div>
            </div>
            <div className="mb-3">
              <div className="text-xs text-muted-foreground">Lowest balance</div>
              <div className="text-sm font-medium">
                {formatMoney(rj.baseline.lowest, currency)}
                {rj.baseline.lowestDate && (
                  <span className="ml-1 text-xs text-muted-foreground">on {rj.baseline.lowestDate}</span>
                )}
              </div>
            </div>
            {rj.baseline.dailyPoints.length > 1 && (
              <Sparkline
                points={rj.baseline.dailyPoints}
                color="var(--chart-scenario)"
                aria-label={`${scenario.name} baseline forecast sparkline`}
              />
            )}
          </Card>

          {/* Scenario card */}
          <Card className="p-4">
            <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Scenario</div>
            <div className="mb-3">
              <div className="text-xs text-muted-foreground">Projected closing</div>
              <div className="flex items-center gap-2">
                <span className="text-xl font-bold">
                  {formatMoney(rj.scenario.closing, currency)}
                </span>
                <DeltaBadge delta={rj.deltas.closing} currency={currency} />
              </div>
            </div>
            <div className="mb-3">
              <div className="text-xs text-muted-foreground">Lowest balance</div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">
                  {formatMoney(rj.scenario.lowest, currency)}
                  {rj.scenario.lowestDate && (
                    <span className="ml-1 text-xs text-muted-foreground">on {rj.scenario.lowestDate}</span>
                  )}
                </span>
                <DeltaBadge delta={rj.deltas.lowest} currency={currency} />
              </div>
            </div>
            {rj.scenario.dailyPoints.length > 1 && (
              <Sparkline
                points={rj.scenario.dailyPoints}
                color={rj.deltas.closing >= 0 ? 'var(--chart-scenario-pos)' : 'var(--chart-scenario-neg)'}
                aria-label={`${scenario.name} scenario forecast sparkline`}
              />
            )}
          </Card>
        </div>
      )}

      {/* Assumptions summary */}
      {scenario.assumptionsJson.overrides.length > 0 && (
        <Card className="mt-4 p-4">
          <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Assumptions</div>
          <ul className="flex flex-col gap-1 text-sm">
            {scenario.assumptionsJson.overrides.map((o, i) => (
              <li key={i} className="flex items-center gap-2">
                <Badge variant="outline" className="shrink-0">
                  {ASSUMPTION_TYPE_LABELS[o.type]}
                </Badge>
                <span className="flex-1">{o.label}</span>
                <span className="font-medium">{formatMoney(o.amount, currency)}</span>
                {o.recurrence && (
                  <span className="text-xs text-muted-foreground">{RECURRENCE_LABELS[o.recurrence]}</span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function ScenariosPage() {
  const { showToast } = useToast()
  const [scenarios, setScenarios] = useState<FinancialScenario[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  // editing: undefined = closed, 'new' = creating, FinancialScenario = editing existing
  const [editing, setEditing] = useState<FinancialScenario | 'new' | undefined>(undefined)
  // Which scenario's comparison panel is expanded.
  const [expanded, setExpanded] = useState<number | null>(null)
  const [deleting, setDeleting] = useState<number | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const res = await getJson<FinancialScenarioListResponse>('/api/financial-scenarios')
      setScenarios(res.data)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  function handleSaved(saved: FinancialScenario) {
    setScenarios((prev) => {
      const idx = prev.findIndex((s) => s.id === saved.id)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = saved
        return next
      }
      return [saved, ...prev]
    })
    setEditing(undefined)
    setExpanded(saved.id)
  }

  async function handleDelete(scenario: FinancialScenario) {
    setDeleting(scenario.id)
    try {
      await deleteReq(`/api/financial-scenarios/${scenario.id}`)
      setScenarios((prev) => prev.filter((s) => s.id !== scenario.id))
      if (expanded === scenario.id) setExpanded(null)
      showToast({ title: 'Scenario deleted', variant: 'success' })
    } catch (e) {
      showToast({
        title: e instanceof Error ? e.message : 'Delete failed',
        variant: 'destructive',
      })
    } finally {
      setDeleting(null)
    }
  }

  function handleRecomputed(updated: FinancialScenario) {
    setScenarios((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
  }

  const COLUMN_COUNT = 5

  return (
    <div className="page">
      <PageHeader
        title="Scenario planner"
        description="Model hypothetical financial changes without touching real data. Compare projected balances and see how decisions affect your cashflow."
        actions={
          <Button type="button" onClick={() => setEditing('new')}>
            <Icon name="plus" className="size-4" /> New scenario
          </Button>
        }
      />

      {err && <Alert variant="error">{err}</Alert>}

      <Card className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Window</TableHead>
              <TableHead>Closing delta</TableHead>
              <TableHead>Assumptions</TableHead>
              <TableHead aria-label="actions" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <SkeletonRow key={`scen-skel-${i}`} cols={COLUMN_COUNT} />
              ))
            ) : scenarios.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT} className="py-8 text-center">
                  <EmptyState
                    title="No scenarios yet"
                    description='Click "New scenario" to model a hypothetical financial change.'
                  />
                </TableCell>
              </TableRow>
            ) : (
              scenarios.flatMap((s) => {
                const rj = s.resultJson
                const currency = rj?.currency ?? 'CAD'
                const isExpanded = expanded === s.id
                return [
                  <TableRow
                    key={s.id}
                    className={isExpanded ? 'bg-muted/40' : ''}
                  >
                    <TableCell>
                      <Button
                        type="button"
                        variant="link"
                        className="text-left font-medium"
                        onClick={() => setExpanded(isExpanded ? null : s.id)}
                      >
                        {s.name}
                      </Button>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {s.assumptionsJson.baselineDays ?? 30}d
                    </TableCell>
                    <TableCell>
                      {rj ? (
                        <DeltaBadge delta={rj.deltas.closing} currency={currency} />
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {s.assumptionsJson.overrides.length}{' '}
                      {s.assumptionsJson.overrides.length === 1 ? 'assumption' : 'assumptions'}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditing(s)}
                          title="Edit scenario"
                        >
                          <Icon name="pencil" className="size-3" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={deleting === s.id}
                          onClick={() => void handleDelete(s)}
                          title="Delete scenario"
                        >
                          <Icon name="trash" className="size-3" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>,
                  // Expanded comparison panel rendered as a full-width row
                  isExpanded && (
                    <TableRow key={`${s.id}-comparison`}>
                      <TableCell colSpan={COLUMN_COUNT} className="p-4">
                        <ComparisonPanel
                          scenario={s}
                          onClose={() => setExpanded(null)}
                          onRecompute={handleRecomputed}
                        />
                      </TableCell>
                    </TableRow>
                  ),
                ].filter(Boolean)
              })
            )}
          </TableBody>
        </Table>
      </Card>

      {editing !== undefined && (
        <ScenarioEditor
          scenario={editing === 'new' ? null : editing}
          onClose={() => setEditing(undefined)}
          onSaved={handleSaved}
        />
      )}
    </div>
  )
}
