/**
 * ActivityForm — form for manually entering investment activities, including
 * the four new corporate action types: dividend_in_kind, spin_off, merger,
 * and return_of_capital.
 */
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { getJson, postJson } from '../../lib/api'
import type { Security } from '../../types/api'

type ActivityType =
  | 'buy'
  | 'sell'
  | 'split'
  | 'reinvestment'
  | 'dividend_in_kind'
  | 'spin_off'
  | 'merger'
  | 'return_of_capital'

const ACTIVITY_TYPE_OPTIONS: Array<{ value: ActivityType; label: string }> = [
  { value: 'buy', label: 'Buy' },
  { value: 'sell', label: 'Sell' },
  { value: 'split', label: 'Split' },
  { value: 'reinvestment', label: 'DRIP (reinvestment)' },
  { value: 'dividend_in_kind', label: 'Dividend in kind (stock dividend)' },
  { value: 'spin_off', label: 'Spin-off' },
  { value: 'merger', label: 'Merger / acquisition' },
  { value: 'return_of_capital', label: 'Return of capital' },
]

const CORPORATE_ACTION_TYPES: ReadonlySet<ActivityType> = new Set([
  'dividend_in_kind',
  'spin_off',
  'merger',
  'return_of_capital',
])

type FormState = {
  activityType: ActivityType
  tradeDate: string
  description: string
  quantity: string
  pricePerShare: string
  amount: string
  fees: string
  splitRatio: string
  currency: string
  securityId: string
  recipientSecurityId: string
  costBasisAllocationPct: string
  cashComponent: string
}

function blankForm(): FormState {
  return {
    activityType: 'buy',
    tradeDate: new Date().toISOString().slice(0, 10),
    description: '',
    quantity: '',
    pricePerShare: '',
    amount: '',
    fees: '',
    splitRatio: '',
    currency: 'CAD',
    securityId: '',
    recipientSecurityId: '',
    costBasisAllocationPct: '',
    cashComponent: '',
  }
}

type Props = {
  accountId: number
  /** Called after a successful save so the parent can refresh. */
  onSaved: () => void
  onCancel: () => void
}

export function ActivityForm({ accountId, onSaved, onCancel }: Props) {
  const [form, setForm] = useState<FormState>(blankForm)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [securities, setSecurities] = useState<Security[]>([])
  const [securitiesLoading, setSecuritiesLoading] = useState(false)

  const activityType = form.activityType
  const needsRecipient = activityType === 'spin_off' || activityType === 'merger'

  // Load securities list when spin_off / merger is selected.
  useEffect(() => {
    if (!needsRecipient) return
    setSecuritiesLoading(true)
    getJson<{ securities: Security[] }>('/api/portfolio/securities')
      .then((res) => setSecurities(res.securities))
      .catch(() => setSecurities([]))
      .finally(() => setSecuritiesLoading(false))
  }, [needsRecipient])

  const set = useCallback((field: keyof FormState, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }, [])

  // Inline validation.
  function validate(): string | null {
    if (!form.tradeDate) return 'Trade date is required.'
    if (activityType === 'dividend_in_kind') {
      if (!form.quantity || Number(form.quantity) <= 0) return 'Shares received must be > 0.'
    }
    if (activityType === 'spin_off') {
      if (!form.quantity || Number(form.quantity) <= 0) return 'Shares received must be > 0.'
      if (!form.recipientSecurityId) return 'Pick the new security.'
      const pct = Number(form.costBasisAllocationPct)
      if (!form.costBasisAllocationPct || pct <= 0 || pct > 1)
        return 'Allocation must be between 0 and 1.'
    }
    if (activityType === 'merger') {
      if (!form.quantity || Number(form.quantity) <= 0) return 'Shares received must be > 0.'
      if (!form.recipientSecurityId) return 'Pick the new security.'
    }
    if (activityType === 'return_of_capital') {
      const hasAmount = form.amount && Number(form.amount) !== 0
      const hasPrice = form.pricePerShare && Number(form.pricePerShare) > 0
      if (!hasAmount && !hasPrice) return 'Enter the amount returned or a price per share > 0.'
    }
    return null
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const validErr = validate()
    if (validErr) {
      setError(validErr)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const body: Record<string, unknown> = {
        accountId,
        activityType: form.activityType,
        tradeDate: form.tradeDate,
        description: form.description || form.activityType,
        currency: form.currency,
      }
      if (form.securityId) body.securityId = Number(form.securityId)
      if (form.quantity) body.quantity = Number(form.quantity)
      if (form.pricePerShare) body.pricePerShare = Number(form.pricePerShare)
      if (form.amount) body.amount = Number(form.amount)
      if (form.fees) body.fees = Number(form.fees)
      if (form.splitRatio) body.splitRatio = Number(form.splitRatio)
      if (form.recipientSecurityId) body.recipientSecurityId = Number(form.recipientSecurityId)
      if (form.costBasisAllocationPct) body.costBasisAllocationPct = Number(form.costBasisAllocationPct)
      if (form.cashComponent) body.cashComponent = Number(form.cashComponent)

      await postJson('/api/portfolio/activities', body)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  const isCorporateAction = CORPORATE_ACTION_TYPES.has(activityType)

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="grid gap-4 py-2">
      {/* Activity type */}
      <div className="grid gap-1">
        <label className="text-sm font-medium" htmlFor="activityType">
          Activity type
        </label>
        <NativeSelect
          id="activityType"
          value={form.activityType}
          onChange={(e) => {
            set('activityType', e.target.value)
            setError(null)
          }}
        >
          {ACTIVITY_TYPE_OPTIONS.map((opt) => (
            <NativeSelectOption key={opt.value} value={opt.value}>
              {opt.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>

      {/* Trade date */}
      <div className="grid gap-1">
        <label className="text-sm font-medium" htmlFor="tradeDate">
          Trade date
        </label>
        <Input
          id="tradeDate"
          type="date"
          value={form.tradeDate}
          onChange={(e) => set('tradeDate', e.target.value)}
          required
        />
      </div>

      {/* Security (original) — not shown for return_of_capital since it's implicit */}
      {activityType !== 'return_of_capital' && (
        <div className="grid gap-1">
          <label className="text-sm font-medium" htmlFor="securityId">
            Security ID{activityType !== 'buy' && activityType !== 'sell' ? ' (optional)' : ''}
          </label>
          <Input
            id="securityId"
            type="number"
            placeholder="e.g. 42"
            value={form.securityId}
            onChange={(e) => set('securityId', e.target.value)}
          />
        </div>
      )}

      {/* Shares received — shown for dividend_in_kind, spin_off, merger */}
      {(activityType === 'dividend_in_kind' ||
        activityType === 'spin_off' ||
        activityType === 'merger') && (
        <div className="grid gap-1">
          <label className="text-sm font-medium" htmlFor="quantity">
            Shares received
          </label>
          <Input
            id="quantity"
            type="number"
            step="any"
            min="0"
            placeholder="0"
            value={form.quantity}
            onChange={(e) => set('quantity', e.target.value)}
          />
        </div>
      )}

      {/* Standard quantity for buy/sell */}
      {(activityType === 'buy' || activityType === 'sell') && (
        <div className="grid gap-1">
          <label className="text-sm font-medium" htmlFor="quantity">
            Quantity
          </label>
          <Input
            id="quantity"
            type="number"
            step="any"
            min="0"
            value={form.quantity}
            onChange={(e) => set('quantity', e.target.value)}
          />
        </div>
      )}

      {/* Price per share — buy, sell, return_of_capital */}
      {(activityType === 'buy' ||
        activityType === 'sell' ||
        activityType === 'return_of_capital') && (
        <div className="grid gap-1">
          <label className="text-sm font-medium" htmlFor="pricePerShare">
            {activityType === 'return_of_capital' ? 'Price per share (amount = price × shares)' : 'Price per share'}
          </label>
          <Input
            id="pricePerShare"
            type="number"
            step="any"
            min="0"
            value={form.pricePerShare}
            onChange={(e) => set('pricePerShare', e.target.value)}
          />
        </div>
      )}

      {/* Amount */}
      {!isCorporateAction && (
        <div className="grid gap-1">
          <label className="text-sm font-medium" htmlFor="amount">
            Amount
          </label>
          <Input
            id="amount"
            type="number"
            step="any"
            value={form.amount}
            onChange={(e) => set('amount', e.target.value)}
          />
        </div>
      )}

      {/* Return of capital — amount */}
      {activityType === 'return_of_capital' && (
        <div className="grid gap-1">
          <label className="text-sm font-medium" htmlFor="amount">
            Amount returned
          </label>
          <Input
            id="amount"
            type="number"
            step="any"
            min="0"
            value={form.amount}
            onChange={(e) => set('amount', e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Reduces cost basis; not income.
          </p>
        </div>
      )}

      {/* Recipient security — spin_off and merger */}
      {needsRecipient && (
        <div className="grid gap-1">
          <label className="text-sm font-medium" htmlFor="recipientSecurityId">
            New security
          </label>
          {securitiesLoading ? (
            <p className="text-sm text-muted-foreground">Loading securities…</p>
          ) : (
            <NativeSelect
              id="recipientSecurityId"
              value={form.recipientSecurityId}
              onChange={(e) => {
                set('recipientSecurityId', e.target.value)
                setError(null)
              }}
            >
              <NativeSelectOption value="">— Select security —</NativeSelectOption>
              {securities.map((s) => (
                <NativeSelectOption key={s.id} value={String(s.id)}>
                  {s.symbol}{s.name ? ` — ${s.name}` : ''}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
          {activityType === 'spin_off' && !form.recipientSecurityId && (
            <p className="text-xs text-destructive">Pick the new security.</p>
          )}
        </div>
      )}

      {/* Cost basis allocation pct — spin_off */}
      {activityType === 'spin_off' && (
        <div className="grid gap-1">
          <label className="text-sm font-medium" htmlFor="costBasisAllocationPct">
            % of cost basis allocated to new security (0–1)
          </label>
          <Input
            id="costBasisAllocationPct"
            type="number"
            step="0.0001"
            min="0.0001"
            max="1"
            placeholder="e.g. 0.25"
            value={form.costBasisAllocationPct}
            onChange={(e) => {
              set('costBasisAllocationPct', e.target.value)
              setError(null)
            }}
          />
          {form.costBasisAllocationPct &&
            (Number(form.costBasisAllocationPct) <= 0 || Number(form.costBasisAllocationPct) > 1) && (
              <p className="text-xs text-destructive">Allocation must be between 0 and 1.</p>
            )}
          <p className="text-xs text-muted-foreground">
            Enter the fraction of the original security&apos;s cost base assigned to the new security.
            The original security retains the remainder.
          </p>
        </div>
      )}

      {/* Cash component — merger */}
      {activityType === 'merger' && (
        <div className="grid gap-1">
          <label className="text-sm font-medium" htmlFor="cashComponent">
            Cash per share received (optional)
          </label>
          <Input
            id="cashComponent"
            type="number"
            step="any"
            min="0"
            placeholder="0"
            value={form.cashComponent}
            onChange={(e) => set('cashComponent', e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Cash boot paid per original share as part of the deal.
            Reduces the cost basis transferred to the new security.
          </p>
        </div>
      )}

      {/* Split ratio */}
      {activityType === 'split' && (
        <div className="grid gap-1">
          <label className="text-sm font-medium" htmlFor="splitRatio">
            Split ratio (e.g. 2 for 2-for-1, 0.1 for 1-for-10 reverse)
          </label>
          <Input
            id="splitRatio"
            type="number"
            step="any"
            min="0"
            value={form.splitRatio}
            onChange={(e) => set('splitRatio', e.target.value)}
          />
        </div>
      )}

      {/* Fees */}
      {!isCorporateAction && (
        <div className="grid gap-1">
          <label className="text-sm font-medium" htmlFor="fees">
            Fees (optional)
          </label>
          <Input
            id="fees"
            type="number"
            step="any"
            min="0"
            value={form.fees}
            onChange={(e) => set('fees', e.target.value)}
          />
        </div>
      )}

      {/* Currency */}
      <div className="grid gap-1">
        <label className="text-sm font-medium" htmlFor="currency">
          Currency
        </label>
        <NativeSelect
          id="currency"
          value={form.currency}
          onChange={(e) => set('currency', e.target.value)}
        >
          <NativeSelectOption value="CAD">CAD</NativeSelectOption>
          <NativeSelectOption value="USD">USD</NativeSelectOption>
        </NativeSelect>
      </div>

      {/* Description */}
      <div className="grid gap-1">
        <label className="text-sm font-medium" htmlFor="description">
          Description (optional)
        </label>
        <Input
          id="description"
          type="text"
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          placeholder={activityType}
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2 justify-end">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save activity'}
        </Button>
      </div>
    </form>
  )
}
