import { useState } from 'react'
import { Calculator, Info, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { postJson } from '@/lib/api'
import { formatMoney } from '../lib/formatMoney'
import { safeNum } from '../lib/num'

/**
 * Opportunity-cost calculator (issue #252): "what if I invested this money
 * instead of spending it?". Projects the future value of a one-time or
 * recurring amount at an assumed return rate over a chosen horizon.
 *
 * This component is the reusable form + results pair. It's mounted standalone
 * on the Opportunity Cost page and can be embedded elsewhere (e.g. a dialog
 * launched from a purchase or transaction). Calculating performs no
 * persistence — it never touches transaction totals.
 *
 * The return rate is shown to the user as a percent (e.g. "7") but the API
 * speaks decimals (0.07), so we convert at the boundary.
 */

type Mode = 'one-time' | 'recurring'
type Cadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual'

type CalculationResult = {
  mode: Mode
  amount: number
  cadence: Cadence
  horizonYears: number
  annualReturnRate: number
  totalContributions: number
  futureValue: number
  gain: number
  monthlyEquivalent: number
  assumptions: string[]
}

const CADENCE_OPTIONS: { value: Cadence; label: string }[] = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Every two weeks' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'annual', label: 'Annually' },
]

export type OpportunityCostCalculatorProps = {
  /** Pre-fill the amount (e.g. from a purchase the user is reviewing). */
  initialAmount?: number
  /** Currency code for formatting results. Defaults to CAD. */
  currency?: string
  /** Default annual return rate as a percent. Defaults to 7. */
  initialReturnPercent?: number
  /** Default horizon in years. Defaults to 10. */
  initialHorizonYears?: number
  className?: string
}

const DEFAULT_RETURN_PERCENT = 7
const DEFAULT_HORIZON_YEARS = 10

export function OpportunityCostCalculator({
  initialAmount = 0,
  currency = 'CAD',
  initialReturnPercent = DEFAULT_RETURN_PERCENT,
  initialHorizonYears = DEFAULT_HORIZON_YEARS,
  className,
}: OpportunityCostCalculatorProps) {
  const defaults = {
    mode: 'one-time' as Mode,
    amount: initialAmount ? String(initialAmount) : '',
    cadence: 'monthly' as Cadence,
    returnPercent: String(initialReturnPercent),
    horizonYears: String(initialHorizonYears),
  }

  const [mode, setMode] = useState<Mode>(defaults.mode)
  const [amount, setAmount] = useState<string>(defaults.amount)
  const [cadence, setCadence] = useState<Cadence>(defaults.cadence)
  const [returnPercent, setReturnPercent] = useState<string>(defaults.returnPercent)
  const [horizonYears, setHorizonYears] = useState<string>(defaults.horizonYears)

  const [result, setResult] = useState<CalculationResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  function reset() {
    setMode(defaults.mode)
    setAmount(defaults.amount)
    setCadence(defaults.cadence)
    setReturnPercent(defaults.returnPercent)
    setHorizonYears(defaults.horizonYears)
    setResult(null)
    setError(null)
  }

  async function calculate(event?: React.FormEvent) {
    event?.preventDefault()
    setError(null)
    const amountVal = safeNum(Number(amount))
    const horizonVal = safeNum(Number(horizonYears))
    const returnVal = safeNum(Number(returnPercent))
    if (amountVal === null || amountVal <= 0) {
      setError('Enter a positive number.')
      return
    }
    if (horizonVal === null || horizonVal <= 0) {
      setError('Enter a positive number.')
      return
    }
    if (returnVal === null || returnVal <= 0) {
      setError('Enter a positive number.')
      return
    }
    setLoading(true)
    try {
      const payload: Record<string, unknown> = {
        mode,
        amount: amountVal,
        horizonYears: horizonVal,
        // Percent in the UI, decimal on the wire.
        annualReturnRate: returnVal / 100,
      }
      if (mode === 'recurring') payload.cadence = cadence

      const data = await postJson<CalculationResult>(
        '/api/opportunity-cost/calculate',
        payload,
      )
      setResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not calculate opportunity cost.')
      setResult(null)
    } finally {
      setLoading(false)
    }
  }

  const amountLabel = mode === 'recurring' ? 'Amount per contribution' : 'Amount'

  return (
    <div className={className}>
      <form onSubmit={calculate} className="grid gap-4">
        <fieldset className="grid gap-2">
          <span className="text-[0.82rem] font-semibold text-muted-foreground">
            What kind of expense?
          </span>
          <div className="flex gap-2" role="group" aria-label="Expense type">
            <Button
              type="button"
              variant={mode === 'one-time' ? 'primary' : 'outline'}
              aria-pressed={mode === 'one-time'}
              onClick={() => setMode('one-time')}
            >
              One-time
            </Button>
            <Button
              type="button"
              variant={mode === 'recurring' ? 'primary' : 'outline'}
              aria-pressed={mode === 'recurring'}
              onClick={() => setMode('recurring')}
            >
              Recurring
            </Button>
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Label>
            {amountLabel}
            <Input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </Label>

          {mode === 'recurring' ? (
            <Label>
              Cadence
              <NativeSelect
                value={cadence}
                onChange={(e) => setCadence(e.target.value as Cadence)}
              >
                {CADENCE_OPTIONS.map((opt) => (
                  <NativeSelectOption key={opt.value} value={opt.value}>
                    {opt.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Label>
          ) : null}

          <Label>
            Assumed annual return rate (%)
            <Input
              type="number"
              inputMode="decimal"
              min="0"
              max="100"
              step="0.1"
              value={returnPercent}
              onChange={(e) => setReturnPercent(e.target.value)}
            />
          </Label>

          <Label>
            Time horizon (years)
            <Input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.5"
              value={horizonYears}
              onChange={(e) => setHorizonYears(e.target.value)}
            />
          </Label>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={loading}>
            <Calculator aria-hidden="true" />
            {loading ? 'Calculating…' : 'Calculate'}
          </Button>
          <Button type="button" variant="ghost" onClick={reset}>
            <RotateCcw aria-hidden="true" />
            Reset
          </Button>
        </div>
      </form>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-rose-600 dark:text-rose-300">
          {error}
        </p>
      ) : null}

      {result ? (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>If you invested this instead</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <ResultStat
                label="Projected future value"
                value={formatMoney(result.futureValue, currency)}
                emphasis
              />
              <ResultStat
                label="Total you'd invest"
                value={formatMoney(result.totalContributions, currency)}
              />
              <ResultStat
                label="Investment growth forgone"
                value={formatMoney(result.gain, currency)}
              />
            </div>

            {result.mode === 'recurring' ? (
              <p className="text-sm text-muted-foreground">
                That's {formatMoney(result.monthlyEquivalent, currency)} per month invested.
              </p>
            ) : null}

            <div className="rounded-md border border-border bg-muted/40 p-3">
              <p className="mb-1 flex items-center gap-1.5 text-[0.82rem] font-semibold text-muted-foreground">
                <Info aria-hidden="true" className="h-3.5 w-3.5" />
                Assumptions
              </p>
              <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
                {result.assumptions.map((a, idx) => (
                  <li key={idx}>{a}</li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">
                This is an estimate and does not change any of your transactions or balances.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}

function ResultStat({
  label,
  value,
  emphasis = false,
}: {
  label: string
  value: string
  emphasis?: boolean
}) {
  return (
    <div className="grid gap-0.5">
      <span className="text-[0.82rem] text-muted-foreground">{label}</span>
      <span
        className={
          emphasis
            ? 'text-2xl font-semibold text-emerald-600 dark:text-emerald-300'
            : 'text-lg font-medium'
        }
      >
        {value}
      </span>
    </div>
  )
}
