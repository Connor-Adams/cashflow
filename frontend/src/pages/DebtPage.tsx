import { useCallback, useMemo, useState } from 'react'
import { PiggyBank, TrendingDown, Save, Pencil } from 'lucide-react'
import { Badge } from '@connor-adams/designsystem'
import { Button } from '@connor-adams/designsystem'
import { Card } from '@connor-adams/designsystem'
import { EmptyState } from '@connor-adams/designsystem'
import { Input } from '@connor-adams/designsystem'
import { Label } from '@connor-adams/designsystem'
import { NativeSelect } from '@connor-adams/designsystem'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@connor-adams/designsystem'
import { useToast } from '@/components/ui/toast'
import { formatMoney } from '../lib/formatMoney'
import {
  useDebt,
  saveLiabilityProfile,
  createScenario,
} from '../hooks/useDebt'
import type {
  DebtLiability,
  DebtPayoffComparison,
  DebtPayoffPlan,
  DebtPayoffStrategy,
} from '../types/api'

const STRATEGY_LABEL: Record<DebtPayoffStrategy, string> = {
  avalanche: 'Avalanche (highest APR first)',
  snowball: 'Snowball (smallest balance first)',
  custom: 'Custom order',
}

/** Format a number of months as "Ny Mm" (or "—" when null/stalled). */
function formatMonths(months: number | null): string {
  if (months == null) return '—'
  if (months <= 0) return '0 mo'
  const y = Math.floor(months / 12)
  const m = months % 12
  if (y > 0 && m > 0) return `${y}y ${m}m`
  if (y > 0) return `${y}y`
  return `${m} mo`
}

export function DebtPage() {
  const [extra, setExtra] = useState<number>(0)
  const { data, loading, error, refresh } = useDebt(extra)

  const currency = data?.currency ?? 'CAD'
  const comparison = data?.comparison ?? null

  const monthlyBudget = useMemo(() => {
    if (!data) return 0
    return data.totalMinimumPayment + data.extraMonthlyPayment
  }, [data])

  return (
    <div className="page">
      <PageHeader
        title="Debt payoff planner"
        description="Compare avalanche vs snowball strategies, see payoff dates and interest saved, then save a plan and feed it into your forecast."
      />

      {error ? (
        <EmptyState
          title="Could not load debt data"
          description={error.message}
          actions={
            <Button size="sm" variant="outline" onClick={refresh}>
              Retry
            </Button>
          }
        />
      ) : null}

      {/* Extra payment control + summary tiles */}
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-3">
          <Label htmlFor="extra-payment" className="text-muted-foreground mb-1 text-xs uppercase tracking-wide">
            Extra monthly payment
          </Label>
          <Input
            id="extra-payment"
            type="number"
            min={0}
            step={25}
            value={Number.isFinite(extra) ? extra : 0}
            onChange={(e) => setExtra(Math.max(0, Number(e.target.value) || 0))}
          />
        </Card>
        <SummaryTile
          label="Total owed"
          value={data ? formatMoney(data.totalOwed, currency) : '—'}
          loading={loading}
        />
        <SummaryTile
          label="Monthly budget"
          value={data ? formatMoney(monthlyBudget, currency) : '—'}
          description={
            data
              ? `${formatMoney(data.totalMinimumPayment, currency)} min + ${formatMoney(data.extraMonthlyPayment, currency)} extra`
              : undefined
          }
          loading={loading}
        />
        <SummaryTile
          label="Interest saved (avalanche)"
          value={comparison ? formatMoney(comparison.interestSaved, currency) : '—'}
          description={comparison ? 'vs snowball' : undefined}
          tone="good"
          loading={loading}
        />
      </div>

      {/* Liabilities table */}
      <Card className="mb-4 p-3">
        <h2 className="mb-2 text-sm font-semibold">Your debts</h2>
        {data && data.liabilities.length > 0 ? (
          <LiabilitiesTable
            liabilities={data.liabilities}
            currency={currency}
            onSaved={refresh}
          />
        ) : (
          <EmptyState
            title="No debts found"
            description={
              loading
                ? 'Loading…'
                : 'Add a credit card, loan, or mortgage account to start planning your payoff.'
            }
          />
        )}
      </Card>

      {/* Strategy comparison */}
      {comparison ? (
        <ComparisonCard comparison={comparison} liabilities={data?.liabilities ?? []} currency={currency} />
      ) : null}

      {/* Save scenario */}
      {data && data.liabilities.length > 0 ? (
        <SaveScenarioCard extra={extra} onSaved={refresh} />
      ) : null}
    </div>
  )
}

type LiabilitiesTableProps = {
  liabilities: DebtLiability[]
  currency: string
  onSaved: () => void
}

function LiabilitiesTable({ liabilities, currency, onSaved }: LiabilitiesTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Account</TableHead>
          <TableHead className="text-right">Balance owed</TableHead>
          <TableHead className="text-right">APR %</TableHead>
          <TableHead className="text-right">Min payment</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {liabilities.map((l) => (
          <LiabilityRow key={l.accountId} liability={l} currency={currency} onSaved={onSaved} />
        ))}
      </TableBody>
    </Table>
  )
}

function LiabilityRow({
  liability,
  currency,
  onSaved,
}: {
  liability: DebtLiability
  currency: string
  onSaved: () => void
}) {
  const { showToast } = useToast()
  const [editing, setEditing] = useState(false)
  const [apr, setApr] = useState(String(liability.interestRate))
  const [minPay, setMinPay] = useState(String(liability.minimumPayment))
  const [saving, setSaving] = useState(false)

  const save = useCallback(async () => {
    setSaving(true)
    try {
      await saveLiabilityProfile(liability.accountId, {
        interestRate: Number(apr) || 0,
        minimumPayment: Number(minPay) || 0,
      })
      setEditing(false)
      onSaved()
      showToast({ title: 'Saved', description: `${liability.name} updated` })
    } catch (e) {
      showToast({
        title: 'Could not save',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }, [apr, minPay, liability.accountId, liability.name, onSaved, showToast])

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-2">
          <span>{liability.name}</span>
          <Badge variant="secondary" className="text-xs">
            {liability.accountType.replace('_', ' ')}
          </Badge>
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {formatMoney(liability.balance, currency)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {editing ? (
          <Input
            type="number"
            min={0}
            step={0.01}
            value={apr}
            onChange={(e) => setApr(e.target.value)}
            className="ml-auto h-8 w-24 text-right"
            aria-label={`${liability.name} APR`}
          />
        ) : (
          `${liability.interestRate.toFixed(2)}%`
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {editing ? (
          <Input
            type="number"
            min={0}
            step={5}
            value={minPay}
            onChange={(e) => setMinPay(e.target.value)}
            className="ml-auto h-8 w-28 text-right"
            aria-label={`${liability.name} minimum payment`}
          />
        ) : (
          formatMoney(liability.minimumPayment, currency)
        )}
      </TableCell>
      <TableCell className="text-right whitespace-nowrap">
        {editing ? (
          <div className="flex justify-end gap-1">
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            <Pencil className="mr-1 size-3" aria-hidden="true" />
            Edit
          </Button>
        )}
      </TableCell>
    </TableRow>
  )
}

type ComparisonCardProps = {
  comparison: DebtPayoffComparison
  liabilities: DebtLiability[]
  currency: string
}

function ComparisonCard({ comparison, liabilities, currency }: ComparisonCardProps) {
  const nameById = useMemo(() => {
    const m = new Map<number, string>()
    for (const l of liabilities) m.set(l.accountId, l.name)
    return m
  }, [liabilities])

  return (
    <Card className="mb-4 p-3">
      <div className="mb-3 flex items-center gap-2">
        <TrendingDown className="size-4 text-positive" aria-hidden="true" />
        <h2 className="text-sm font-semibold">Avalanche vs snowball</h2>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <PlanSummary
          title="Avalanche"
          subtitle="Highest APR first — least interest"
          plan={comparison.avalanche}
          nameById={nameById}
          currency={currency}
          highlight
        />
        <PlanSummary
          title="Snowball"
          subtitle="Smallest balance first — fastest first win"
          plan={comparison.snowball}
          nameById={nameById}
          currency={currency}
        />
      </div>
      <p className="text-muted-foreground mt-3 mb-0 text-sm">
        The avalanche saves{' '}
        <span className="font-semibold text-positive">
          {formatMoney(comparison.interestSaved, currency)}
        </span>{' '}
        in interest compared with the snowball.
      </p>
    </Card>
  )
}

function PlanSummary({
  title,
  subtitle,
  plan,
  nameById,
  currency,
  highlight,
}: {
  title: string
  subtitle: string
  plan: DebtPayoffPlan
  nameById: Map<number, string>
  currency: string
  highlight?: boolean
}) {
  return (
    <Card
      className={`p-3 ${highlight ? 'border-positive' : ''}`}
    >
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        <Badge variant={highlight ? 'default' : 'secondary'} className="text-xs">
          {formatMonths(plan.stalled ? null : plan.totalMonths)}
        </Badge>
      </div>
      <p className="text-muted-foreground mb-2 text-xs">{subtitle}</p>
      <dl className="grid grid-cols-2 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Total interest</dt>
        <dd className="text-right tabular-nums">{formatMoney(plan.totalInterest, currency)}</dd>
        <dt className="text-muted-foreground">Total paid</dt>
        <dd className="text-right tabular-nums">{formatMoney(plan.totalPaid, currency)}</dd>
      </dl>
      {plan.stalled ? (
        <p className="mt-2 mb-0 text-xs text-warning">
          Minimum payments don't cover the interest — increase the extra payment to make progress.
        </p>
      ) : (
        <ol className="mt-2 mb-0 list-decimal pl-5 text-xs">
          {plan.order.map((id) => (
            <li key={id}>
              {nameById.get(id) ?? `Account ${id}`} —{' '}
              <span className="text-muted-foreground">{formatMonths(plan.payoffMonthByDebt[id] ?? null)}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  )
}

function SaveScenarioCard({ extra, onSaved }: { extra: number; onSaved: () => void }) {
  const { showToast } = useToast()
  const [name, setName] = useState('')
  const [strategy, setStrategy] = useState<DebtPayoffStrategy>('avalanche')
  const [feedForecast, setFeedForecast] = useState(true)
  const [saving, setSaving] = useState(false)

  const save = useCallback(async () => {
    if (!name.trim()) {
      showToast({ title: 'Name required', variant: 'destructive' })
      return
    }
    setSaving(true)
    try {
      await createScenario({
        name: name.trim(),
        strategy,
        extraMonthlyPayment: extra,
        feedForecast,
      })
      setName('')
      onSaved()
      showToast({
        title: 'Scenario saved',
        description: feedForecast ? 'Payments added to your forecast' : undefined,
      })
    } catch (e) {
      showToast({
        title: 'Could not save scenario',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }, [name, strategy, extra, feedForecast, onSaved, showToast])

  return (
    <Card className="p-3">
      <div className="mb-3 flex items-center gap-2">
        <PiggyBank className="size-4" aria-hidden="true" />
        <h2 className="text-sm font-semibold">Save a payoff plan</h2>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <Label htmlFor="scenario-name" className="text-muted-foreground mb-1 text-xs">
            Plan name
          </Label>
          <Input
            id="scenario-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Debt-free by 2028"
          />
        </div>
        <div>
          <Label htmlFor="scenario-strategy" className="text-muted-foreground mb-1 text-xs">
            Strategy
          </Label>
          <NativeSelect
            id="scenario-strategy"
            value={strategy}
            onChange={(e) => setStrategy(e.target.value as DebtPayoffStrategy)}
          >
            {(['avalanche', 'snowball'] as const).map((s) => (
              <option key={s} value={s}>
                {STRATEGY_LABEL[s]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <label className="flex items-end gap-2 pb-1 text-sm">
          <input
            type="checkbox"
            checked={feedForecast}
            onChange={(e) => setFeedForecast(e.target.checked)}
            className="size-4"
          />
          <span>Add payments to forecast</span>
        </label>
        <div className="flex items-end">
          <Button onClick={save} disabled={saving} className="w-full">
            <Save className="mr-1 size-4" aria-hidden="true" />
            {saving ? 'Saving…' : 'Save plan'}
          </Button>
        </div>
      </div>
    </Card>
  )
}

type SummaryTileProps = {
  label: string
  value: string
  description?: string
  tone?: 'default' | 'good'
  loading?: boolean
}

function SummaryTile({ label, value, description, tone, loading }: SummaryTileProps) {
  const displayValue = loading ? '…' : value
  return (
    <StatCard
      label={label}
      value={
        tone === 'good' ? (
          <span className="text-positive">{displayValue}</span>
        ) : (
          displayValue
        )
      }
      hint={description}
    />
  )
}
