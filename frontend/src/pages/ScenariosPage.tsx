import { useCallback, useMemo, useState } from 'react'
import { Plus, Trash2, ArrowUpRight, ArrowDownRight, FlaskConical } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select'
import { PageHeader } from '@/components/ui/page-header'
import { useToast } from '@/components/ui/toast'
import { formatMoney } from '../lib/formatMoney'
import {
  useFinancialScenarios,
  createFinancialScenario,
  deleteFinancialScenario,
} from '../hooks/useFinancialScenarios'
import type { FinancialScenario, ScenarioMetrics } from '../types/api'
import {
  KIND_LABEL,
  newDraft,
  draftsToAssumptions,
  describeAssumption,
  type AssumptionKind,
  type DraftAssumption,
} from './scenarioAssumptions'

const HORIZON_OPTIONS = [30, 60, 90, 180, 365]

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export function ScenariosPage() {
  const { showToast } = useToast()
  const { data: scenarios, loading, error, refresh } = useFinancialScenarios()

  const [name, setName] = useState('')
  const [horizonDays, setHorizonDays] = useState(90)
  const [drafts, setDrafts] = useState<DraftAssumption[]>([newDraft()])
  const [submitting, setSubmitting] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  const selected = useMemo(
    () => scenarios?.find((s) => s.id === selectedId) ?? null,
    [scenarios, selectedId],
  )

  const updateDraft = useCallback(
    (idx: number, patch: Partial<DraftAssumption>) => {
      setDrafts((prev) =>
        prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)),
      )
    },
    [],
  )

  const addDraft = useCallback(() => {
    setDrafts((prev) => [...prev, newDraft()])
  }, [])

  const removeDraft = useCallback((idx: number) => {
    setDrafts((prev) => prev.filter((_, i) => i !== idx))
  }, [])

  const submit = useCallback(async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      showToast({ title: 'Name your scenario first', variant: 'destructive' })
      return
    }
    setSubmitting(true)
    try {
      const created = await createFinancialScenario({
        name: trimmed,
        horizonDays,
        assumptions: draftsToAssumptions(drafts),
      })
      showToast({ title: 'Scenario saved' })
      setName('')
      setDrafts([newDraft()])
      setSelectedId(created.id)
      refresh()
    } catch (e) {
      showToast({
        title: 'Could not save scenario',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }, [name, horizonDays, drafts, refresh, showToast])

  const remove = useCallback(
    async (id: number) => {
      setDeletingId(id)
      try {
        await deleteFinancialScenario(id)
        if (selectedId === id) setSelectedId(null)
        showToast({ title: 'Scenario deleted' })
        refresh()
      } catch (e) {
        showToast({
          title: 'Could not delete scenario',
          description: e instanceof Error ? e.message : String(e),
          variant: 'destructive',
        })
      } finally {
        setDeletingId(null)
      }
    },
    [selectedId, refresh, showToast],
  )

  return (
    <div className="page">
      <PageHeader
        title="Scenarios"
        description="Model hypothetical changes — buy a car, a pay cut, saving more — without touching your real data, and compare against your current forecast."
      />

      {error ? (
        <EmptyState
          title="Could not load scenarios"
          description={error.message}
          actions={
            <Button size="sm" variant="outline" onClick={refresh}>
              Retry
            </Button>
          }
        />
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Builder */}
        <Card className="p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <FlaskConical className="size-4" aria-hidden="true" />
            New scenario
          </h2>

          <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="scenario-name">Name</Label>
              <Input
                id="scenario-name"
                placeholder="e.g. Buy a car"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="scenario-horizon">Horizon</Label>
              <NativeSelect
                id="scenario-horizon"
                value={String(horizonDays)}
                onChange={(e) => setHorizonDays(Number(e.target.value))}
              >
                {HORIZON_OPTIONS.map((d) => (
                  <NativeSelectOption key={d} value={String(d)}>
                    {d} days
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          </div>

          <div className="mb-2 flex items-center justify-between">
            <Label>Assumptions</Label>
            <Button size="sm" variant="outline" onClick={addDraft}>
              <Plus className="mr-1 size-3" aria-hidden="true" />
              Add
            </Button>
          </div>

          <div className="space-y-2">
            {drafts.map((d, idx) => (
              <div
                key={idx}
                className="flex flex-wrap items-end gap-2 rounded-md border border-zinc-200 p-2 dark:border-zinc-800"
              >
                <div className="min-w-40 grow">
                  <Label htmlFor={`kind-${idx}`} className="text-xs">
                    Type
                  </Label>
                  <NativeSelect
                    id={`kind-${idx}`}
                    value={d.kind}
                    onChange={(e) =>
                      updateDraft(idx, { kind: e.target.value as AssumptionKind })
                    }
                  >
                    {(Object.keys(KIND_LABEL) as AssumptionKind[]).map((k) => (
                      <NativeSelectOption key={k} value={k}>
                        {KIND_LABEL[k]}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>

                {(d.kind === 'income_pct' || d.kind === 'expense_pct') && (
                  <div className="w-28">
                    <Label htmlFor={`pct-${idx}`} className="text-xs">
                      Percent
                    </Label>
                    <Input
                      id={`pct-${idx}`}
                      type="number"
                      inputMode="decimal"
                      placeholder="-30"
                      value={d.pct}
                      onChange={(e) => updateDraft(idx, { pct: e.target.value })}
                    />
                  </div>
                )}

                {d.kind === 'savings_monthly' && (
                  <div className="w-32">
                    <Label htmlFor={`amt-${idx}`} className="text-xs">
                      Amount / mo
                    </Label>
                    <Input
                      id={`amt-${idx}`}
                      type="number"
                      inputMode="decimal"
                      placeholder="2000"
                      value={d.amount}
                      onChange={(e) => updateDraft(idx, { amount: e.target.value })}
                    />
                  </div>
                )}

                {d.kind === 'one_off' && (
                  <>
                    <div className="w-32">
                      <Label htmlFor={`amt-${idx}`} className="text-xs">
                        Amount
                      </Label>
                      <Input
                        id={`amt-${idx}`}
                        type="number"
                        inputMode="decimal"
                        placeholder="25000"
                        value={d.amount}
                        onChange={(e) => updateDraft(idx, { amount: e.target.value })}
                      />
                    </div>
                    <div className="w-28">
                      <Label htmlFor={`dir-${idx}`} className="text-xs">
                        Direction
                      </Label>
                      <NativeSelect
                        id={`dir-${idx}`}
                        value={d.direction}
                        onChange={(e) =>
                          updateDraft(idx, {
                            direction: e.target.value as 'in' | 'out',
                          })
                        }
                      >
                        <NativeSelectOption value="out">Spend</NativeSelectOption>
                        <NativeSelectOption value="in">Receive</NativeSelectOption>
                      </NativeSelect>
                    </div>
                    <div className="w-40">
                      <Label htmlFor={`date-${idx}`} className="text-xs">
                        Date
                      </Label>
                      <Input
                        id={`date-${idx}`}
                        type="date"
                        min={todayIso()}
                        value={d.date}
                        onChange={(e) => updateDraft(idx, { date: e.target.value })}
                      />
                    </div>
                  </>
                )}

                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Remove assumption"
                  onClick={() => removeDraft(idx)}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              </div>
            ))}
          </div>

          <div className="mt-4">
            <Button onClick={submit} disabled={submitting}>
              {submitting ? 'Computing…' : 'Compute & save scenario'}
            </Button>
          </div>
        </Card>

        {/* Saved scenarios + comparison */}
        <div className="space-y-4">
          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold">Saved scenarios</h2>
            {scenarios && scenarios.length > 0 ? (
              <ul className="space-y-2">
                {scenarios.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(s.id)}
                      className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left transition ${
                        s.id === selectedId
                          ? 'border-emerald-400 bg-emerald-50 dark:border-emerald-600 dark:bg-emerald-900/30'
                          : 'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900'
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{s.name}</span>
                        <span className="muted block truncate text-xs">
                          {s.assumptions.length === 0
                            ? 'No assumptions (baseline)'
                            : s.assumptions
                                .map((a) => describeAssumption(a, s.currency))
                                .join(' · ')}
                        </span>
                      </span>
                      <Badge variant="secondary" className="ml-2 shrink-0 text-xs">
                        {s.horizonDays}d
                      </Badge>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                title="No scenarios yet"
                description={
                  loading ? 'Loading…' : 'Build one on the left to compare it against your forecast.'
                }
              />
            )}
          </Card>

          {selected && selected.result ? (
            <ScenarioComparison
              scenario={selected}
              onDelete={() => remove(selected.id)}
              deleting={deletingId === selected.id}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}

type ComparisonProps = {
  scenario: FinancialScenario
  onDelete: () => void
  deleting: boolean
}

function ScenarioComparison({ scenario, onDelete, deleting }: ComparisonProps) {
  const { result, currency } = scenario
  if (!result) return null
  const rows: Array<{ label: string; key: keyof ScenarioMetrics }> = [
    { label: 'Projected closing balance', key: 'projectedClosingBalance' },
    { label: 'Lowest projected balance', key: 'lowestProjectedBalance' },
    { label: 'Safe-to-spend', key: 'safeToSpend' },
    { label: 'Net worth', key: 'netWorth' },
  ]

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">{scenario.name} vs current</h2>
        <Button
          size="sm"
          variant="outline"
          onClick={onDelete}
          disabled={deleting}
        >
          <Trash2 className="mr-1 size-3" aria-hidden="true" />
          {deleting ? 'Deleting…' : 'Delete'}
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
              <th className="py-1 pr-2 font-medium">Metric</th>
              <th className="py-1 px-2 text-right font-medium">Current</th>
              <th className="py-1 px-2 text-right font-medium">Scenario</th>
              <th className="py-1 pl-2 text-right font-medium">Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ label, key }) => {
              const delta = result.deltas[key]
              const positive = delta > 0
              const negative = delta < 0
              return (
                <tr key={key} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-2">{label}</td>
                  <td className="py-2 px-2 text-right tabular-nums">
                    {formatMoney(result.base[key], currency)}
                  </td>
                  <td className="py-2 px-2 text-right font-medium tabular-nums">
                    {formatMoney(result.scenario[key], currency)}
                  </td>
                  <td
                    className={`py-2 pl-2 text-right tabular-nums ${
                      positive
                        ? 'text-emerald-600 dark:text-emerald-300'
                        : negative
                          ? 'text-rose-600 dark:text-rose-300'
                          : 'text-zinc-500'
                    }`}
                  >
                    <span className="inline-flex items-center justify-end gap-1">
                      {positive ? (
                        <ArrowUpRight className="size-3" aria-hidden="true" />
                      ) : negative ? (
                        <ArrowDownRight className="size-3" aria-hidden="true" />
                      ) : null}
                      {delta > 0 ? '+' : ''}
                      {formatMoney(delta, currency)}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
