import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  MoneyInput,
  Switch,
} from '@connor-adams/designsystem'
import { getJson, patchJson } from '@/lib/api'
import { getAppConfig } from '@/lib/appConfig'
import type { CashflowSettings } from '@/types/api'

/**
 * Settings → Cashflow. Exposes the per-user CashflowSettings knobs the app
 * reads but previously had no control for:
 *  - safe-to-spend: minimum cash buffer, look-ahead window, and whether
 *    credit-card statements / goal contributions are reserved
 *    (backend/src/cashflow/safeToSpend.ts)
 *  - surplus: assumed annual return for the payoff-vs-invest comparison
 *    (backend/src/cashflow/surplus.ts)
 *  - large purchases: the review threshold (routes/largePurchaseReview.ts)
 *  - partner fairness: exclude non-partner inflows (also toggled in place on
 *    the Fairness page; both write the same field)
 *
 * `counterpartyPromotionThreshold` is deliberately absent: no UI lists
 * counterparty promotions, so the knob would change nothing visible.
 *
 * Saves the changed fields only via PATCH /api/settings/cashflow. Ranges
 * mirror the server validator, which stays the source of truth.
 */

type Draft = {
  minimumCashBuffer: string
  safeToSpendWindowDays: string
  includeCreditCardBalance: boolean
  includeGoalContributions: boolean
  /** Percent (5 == 5%); the API stores a decimal (0.05). */
  assumedAnnualReturnPct: string
  largePurchaseThreshold: string
  excludeNonPartnerInflows: boolean
}

type NumericKey =
  | 'minimumCashBuffer'
  | 'safeToSpendWindowDays'
  | 'assumedAnnualReturnPct'
  | 'largePurchaseThreshold'
type BooleanKey =
  | 'includeCreditCardBalance'
  | 'includeGoalContributions'
  | 'excludeNonPartnerInflows'

type Rule = { min: number; max: number; integer?: boolean; message: string }

const RULES: Record<NumericKey, Rule> = {
  minimumCashBuffer: {
    min: 0,
    max: 1_000_000_000,
    message: 'Enter an amount from 0 to 1,000,000,000.',
  },
  safeToSpendWindowDays: {
    min: 1,
    max: 365,
    integer: true,
    message: 'Enter a whole number of days from 1 to 365.',
  },
  assumedAnnualReturnPct: { min: 0, max: 100, message: 'Enter a percentage from 0 to 100.' },
  largePurchaseThreshold: {
    min: 0,
    max: 1_000_000,
    message: 'Enter an amount from 0 to 1,000,000.',
  },
}

const NUMERIC_KEYS = Object.keys(RULES) as NumericKey[]
const BOOLEAN_KEYS: BooleanKey[] = [
  'includeCreditCardBalance',
  'includeGoalContributions',
  'excludeNonPartnerInflows',
]

/** Plain-language names used to rewrite server validation errors. */
const API_FIELD_LABELS: Record<string, string> = {
  minimumCashBuffer: 'Minimum cash buffer',
  safeToSpendWindowDays: 'Look-ahead window',
  includeCreditCardBalance: 'Reserve credit-card payments',
  includeGoalContributions: 'Reserve goal contributions',
  assumedAnnualReturnRate: 'Assumed investment return',
  largePurchaseThreshold: 'Large purchase threshold',
  excludeNonPartnerInflows: 'Exclude non-partner inflows',
}

/** "250.0000" → "250" so the money inputs start clean. */
function trimDecimal(raw: string | undefined, fallback: string): string {
  const n = Number(raw ?? fallback)
  return Number.isFinite(n) ? String(n) : fallback
}

function toDraft(s: CashflowSettings): Draft {
  const rate = Number(s.assumedAnnualReturnRate ?? '0.05')
  return {
    minimumCashBuffer: trimDecimal(s.minimumCashBuffer, '0'),
    safeToSpendWindowDays: String(s.safeToSpendWindowDays),
    includeCreditCardBalance: s.includeCreditCardBalance,
    includeGoalContributions: s.includeGoalContributions,
    assumedAnnualReturnPct: String(Number((rate * 100).toFixed(2))),
    largePurchaseThreshold: trimDecimal(s.largePurchaseThreshold, '500'),
    excludeNonPartnerInflows: s.excludeNonPartnerInflows,
  }
}

function fieldError(key: NumericKey, raw: string): string | null {
  const rule = RULES[key]
  const n = raw.trim() === '' ? NaN : Number(raw)
  const ok =
    Number.isFinite(n) && n >= rule.min && n <= rule.max && (!rule.integer || Number.isInteger(n))
  return ok ? null : rule.message
}

/** The PATCH body: only fields that differ from what was last saved. */
function buildPatch(saved: Draft, draft: Draft): Record<string, number | boolean> {
  const patch: Record<string, number | boolean> = {}
  for (const key of NUMERIC_KEYS) {
    const next = Number(draft[key])
    if (next === Number(saved[key])) continue
    if (key === 'assumedAnnualReturnPct') {
      patch.assumedAnnualReturnRate = Number((next / 100).toFixed(4))
    } else {
      patch[key] = next
    }
  }
  for (const key of BOOLEAN_KEYS) {
    if (draft[key] !== saved[key]) patch[key] = draft[key]
  }
  return patch
}

function friendlyError(e: unknown): string {
  const message = e instanceof Error && e.message ? e.message : 'Something went wrong.'
  const field = Object.keys(API_FIELD_LABELS).find((k) => message.startsWith(k))
  const text = field ? API_FIELD_LABELS[field] + message.slice(field.length) : message
  return `Couldn’t save your changes. ${text}`
}

type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string }

export function CashflowTab() {
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading')
  const [saved, setSaved] = useState<Draft | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })
  const currency = getAppConfig()?.defaultCurrency ?? 'CAD'

  const load = useCallback(async () => {
    setStatus('loading')
    try {
      const s = await getJson<CashflowSettings>('/api/settings/cashflow')
      setSaved(toDraft(s))
      setDraft(toDraft(s))
      setStatus('ready')
    } catch {
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (status === 'loading') {
    return (
      <div className="space-y-2" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-md bg-muted" />
        ))}
      </div>
    )
  }

  if (status === 'error' || !saved || !draft) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">Couldn’t load cashflow settings.</p>
        <Button type="button" variant="link" size="sm" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    )
  }

  const errors = Object.fromEntries(
    NUMERIC_KEYS.map((k) => [k, fieldError(k, draft[k])]),
  ) as Record<NumericKey, string | null>
  const hasErrors = NUMERIC_KEYS.some((k) => errors[k] !== null)
  const patch = buildPatch(saved, draft)
  const dirty = Object.keys(patch).length > 0

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((cur) => (cur ? { ...cur, [key]: value } : cur))
    setSave({ kind: 'idle' })
  }

  async function onSave() {
    setSave({ kind: 'saving' })
    try {
      const next = toDraft(await patchJson<CashflowSettings>('/api/settings/cashflow', patch))
      setSaved(next)
      setDraft(next)
      setSave({ kind: 'saved' })
    } catch (e) {
      setSave({ kind: 'error', message: friendlyError(e) })
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Cashflow</h2>
        <p className="text-sm text-muted-foreground">
          Tune how Cashflow works out what you can spend. Amounts are in {currency}.
        </p>
      </div>

      <SettingsGroup
        title="Safe to spend"
        description="The dashboard number for how much you can spend without dipping into money you've already committed."
      >
        <NumberField
          id="cashflow-minimum-buffer"
          label="Minimum cash buffer"
          help="Keep at least this much cash untouched when computing safe-to-spend. It's subtracted before anything is shown as spendable."
          error={errors.minimumCashBuffer}
        >
          <MoneyInput
            id="cashflow-minimum-buffer"
            aria-describedby="cashflow-minimum-buffer-help"
            currency={currency}
            value={draft.minimumCashBuffer}
            invalid={errors.minimumCashBuffer !== null}
            onValueChange={(_n, raw) => update('minimumCashBuffer', raw)}
          />
        </NumberField>
        <NumberField
          id="cashflow-window-days"
          label="Look-ahead window"
          help="How many days ahead to count upcoming bills and expected income."
          error={errors.safeToSpendWindowDays}
          suffix="days"
        >
          <Input
            id="cashflow-window-days"
            aria-describedby="cashflow-window-days-help"
            type="number"
            inputMode="numeric"
            min={1}
            max={365}
            step={1}
            value={draft.safeToSpendWindowDays}
            invalid={errors.safeToSpendWindowDays !== null}
            onChange={(e) => update('safeToSpendWindowDays', e.target.value)}
          />
        </NumberField>
        <ToggleField
          id="cashflow-include-cc"
          label="Reserve credit-card payments"
          help="Set aside each card's statement balance before showing what's safe to spend. Turn off if you pay your cards from money that isn't counted here."
          checked={draft.includeCreditCardBalance}
          onChange={(v) => update('includeCreditCardBalance', v)}
        />
        <ToggleField
          id="cashflow-include-goals"
          label="Reserve goal contributions"
          help="Set aside what your active savings goals need this window. Turn off to treat goal saving as optional."
          checked={draft.includeGoalContributions}
          onChange={(v) => update('includeGoalContributions', v)}
        />
      </SettingsGroup>

      <SettingsGroup
        title="Surplus"
        description="When there's money left over beyond your buffer, the dashboard compares paying down debt with investing it."
      >
        <NumberField
          id="cashflow-return-rate"
          label="Assumed investment return"
          help="The yearly return to assume for money you invest. Higher values favour investing over paying down debt."
          error={errors.assumedAnnualReturnPct}
          suffix="% per year"
        >
          <Input
            id="cashflow-return-rate"
            aria-describedby="cashflow-return-rate-help"
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            step={0.1}
            value={draft.assumedAnnualReturnPct}
            invalid={errors.assumedAnnualReturnPct !== null}
            onChange={(e) => update('assumedAnnualReturnPct', e.target.value)}
          />
        </NumberField>
      </SettingsGroup>

      <SettingsGroup
        title="Large purchases"
        description="Big purchases are queued under Transactions → Large for a quick review."
      >
        <NumberField
          id="cashflow-large-purchase"
          label="Large purchase threshold"
          help="Purchases of this amount or more are flagged for review. Set to 0 to review every purchase."
          error={errors.largePurchaseThreshold}
        >
          <MoneyInput
            id="cashflow-large-purchase"
            aria-describedby="cashflow-large-purchase-help"
            currency={currency}
            value={draft.largePurchaseThreshold}
            invalid={errors.largePurchaseThreshold !== null}
            onValueChange={(_n, raw) => update('largePurchaseThreshold', raw)}
          />
        </NumberField>
      </SettingsGroup>

      <SettingsGroup
        title="Partner fairness"
        description="How the Fairness page splits shared money between you and your partner."
      >
        <ToggleField
          id="cashflow-exclude-non-partner"
          label="Exclude non-partner inflows"
          help="Ignore shared money coming in from anyone other than your partner, so the balance reflects only what the two of you put in. Also available on the Fairness page."
          checked={draft.excludeNonPartnerInflows}
          onChange={(v) => update('excludeNonPartnerInflows', v)}
        />
      </SettingsGroup>

      {save.kind === 'error' ? <Alert variant="error">{save.message}</Alert> : null}

      <div className="flex items-center gap-3">
        <Button
          type="button"
          disabled={!dirty || hasErrors || save.kind === 'saving'}
          onClick={() => void onSave()}
        >
          {save.kind === 'saving' ? 'Saving…' : 'Save changes'}
        </Button>
        {save.kind === 'saved' ? (
          <span role="status" className="text-sm text-success">
            Saved
          </span>
        ) : null}
      </div>
    </div>
  )
}

function SettingsGroup({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-5">{children}</div>
      </CardContent>
    </Card>
  )
}

function NumberField({
  id,
  label,
  help,
  error,
  suffix,
  children,
}: {
  id: string
  label: string
  help: string
  error: string | null
  suffix?: string
  children: ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex max-w-xs items-center gap-2">
        <div className="min-w-0 flex-1">{children}</div>
        {suffix ? <span className="shrink-0 text-sm text-muted-foreground">{suffix}</span> : null}
      </div>
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        {help}
      </p>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  )
}

function ToggleField({
  id,
  label,
  help,
  checked,
  onChange,
}: {
  id: string
  label: string
  help: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-1">
        <Label htmlFor={id}>{label}</Label>
        <p id={`${id}-help`} className="text-xs text-muted-foreground">
          {help}
        </p>
      </div>
      <Switch
        id={id}
        aria-describedby={`${id}-help`}
        checked={checked}
        onCheckedChange={onChange}
      />
    </div>
  )
}
