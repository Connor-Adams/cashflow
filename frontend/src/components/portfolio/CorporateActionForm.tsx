import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { postJson } from '@/lib/api'
import type { Account } from '@cashflow/shared'

export type SecurityOption = { id: number; symbol: string; name: string }

type Props = {
  accounts: Account[]
  securities: SecurityOption[]
  onSaved: () => void
}

const ACTIVITY_TYPES = [
  { value: 'buy', label: 'Buy' },
  { value: 'sell', label: 'Sell' },
  { value: 'split', label: 'Split' },
  { value: 'reinvestment', label: 'DRIP' },
  { value: 'dividend_in_kind', label: 'Dividend in kind (stock dividend)' },
  { value: 'spin_off', label: 'Spin-off' },
  { value: 'merger', label: 'Merger / acquisition' },
  { value: 'return_of_capital', label: 'Return of capital' },
] as const

type ActivityType = (typeof ACTIVITY_TYPES)[number]['value']

const NEEDS_RECIPIENT: ActivityType[] = ['spin_off', 'merger']
const NEEDS_ALLOCATION: ActivityType[] = ['spin_off']
const NEEDS_CASH_COMPONENT: ActivityType[] = ['merger']
const NEEDS_QUANTITY: ActivityType[] = ['buy', 'sell', 'split', 'reinvestment', 'dividend_in_kind', 'spin_off', 'merger']
const NEEDS_AMOUNT: ActivityType[] = ['buy', 'sell', 'reinvestment', 'return_of_capital']
const NEEDS_SPLIT_RATIO: ActivityType[] = ['split']

export function CorporateActionForm({ accounts, securities, onSaved }: Props) {
  const [activityType, setActivityType] = useState<ActivityType>('dividend_in_kind')
  const [accountId, setAccountId] = useState<string>('')
  const [securityId, setSecurityId] = useState<string>('')
  const [recipientSecurityId, setRecipientSecurityId] = useState<string>('')
  const [tradeDate, setTradeDate] = useState('')
  const [quantity, setQuantity] = useState('')
  const [amount, setAmount] = useState('')
  const [splitRatio, setSplitRatio] = useState('')
  const [costBasisAllocationPct, setCostBasisAllocationPct] = useState('')
  const [cashComponent, setCashComponent] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await postJson('/api/portfolio/activities', {
        accountId: accountId ? Number(accountId) : undefined,
        securityId: securityId ? Number(securityId) : undefined,
        activityType,
        tradeDate,
        quantity: quantity || undefined,
        amount: amount || undefined,
        splitRatio: splitRatio || undefined,
        recipientSecurityId: recipientSecurityId ? Number(recipientSecurityId) : undefined,
        costBasisAllocationPct: costBasisAllocationPct || undefined,
        cashComponent: cashComponent || undefined,
        description: description || undefined,
      })
      // Reset
      setQuantity('')
      setAmount('')
      setSplitRatio('')
      setCostBasisAllocationPct('')
      setCashComponent('')
      setDescription('')
      setRecipientSecurityId('')
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save activity')
    } finally {
      setSaving(false)
    }
  }

  const needsRecipient = NEEDS_RECIPIENT.includes(activityType as typeof NEEDS_RECIPIENT[number])
  const needsAllocation = NEEDS_ALLOCATION.includes(activityType as typeof NEEDS_ALLOCATION[number])
  const needsCash = NEEDS_CASH_COMPONENT.includes(activityType as typeof NEEDS_CASH_COMPONENT[number])
  const needsQty = NEEDS_QUANTITY.includes(activityType as typeof NEEDS_QUANTITY[number])
  const needsAmount = NEEDS_AMOUNT.includes(activityType as typeof NEEDS_AMOUNT[number])
  const needsSplitRatio = NEEDS_SPLIT_RATIO.includes(activityType as typeof NEEDS_SPLIT_RATIO[number])

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3 p-4 rounded-lg border bg-muted/20">
      <h3 className="font-semibold text-sm">Record corporate action</h3>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <div className="space-y-1">
          <label className="text-xs font-medium">Type</label>
          <select
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            value={activityType}
            onChange={(e) => setActivityType(e.target.value as ActivityType)}
          >
            {ACTIVITY_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium">Account</label>
          <select
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            required
          >
            <option value="">— Select account —</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium">Security</label>
          <select
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            value={securityId}
            onChange={(e) => setSecurityId(e.target.value)}
          >
            <option value="">— Select security —</option>
            {securities.map((s) => (
              <option key={s.id} value={s.id}>{s.symbol} – {s.name}</option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium">Trade date</label>
          <Input
            type="date"
            value={tradeDate}
            onChange={(e) => setTradeDate(e.target.value)}
            required
          />
        </div>

        {needsQty && (
          <div className="space-y-1">
            <label className="text-xs font-medium">
              {activityType === 'dividend_in_kind' ? 'Shares received' : 'Quantity'}
            </label>
            <Input
              type="number"
              step="any"
              min="0"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="e.g. 10"
            />
            {activityType === 'dividend_in_kind' && (
              <p className="text-xs text-muted-foreground">Increases share count without taxable income</p>
            )}
          </div>
        )}

        {needsAmount && (
          <div className="space-y-1">
            <label className="text-xs font-medium">
              {activityType === 'return_of_capital' ? 'Amount returned' : 'Amount'}
            </label>
            <Input
              type="number"
              step="any"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g. 500.00"
            />
            {activityType === 'return_of_capital' && (
              <p className="text-xs text-muted-foreground">Reduces cost basis; not income.</p>
            )}
          </div>
        )}

        {needsSplitRatio && (
          <div className="space-y-1">
            <label className="text-xs font-medium">Split ratio</label>
            <Input
              type="number"
              step="any"
              min="0"
              value={splitRatio}
              onChange={(e) => setSplitRatio(e.target.value)}
              placeholder="e.g. 2 for 2-for-1"
            />
          </div>
        )}

        {needsRecipient && (
          <div className="space-y-1">
            <label className="text-xs font-medium">New security</label>
            <select
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              value={recipientSecurityId}
              onChange={(e) => setRecipientSecurityId(e.target.value)}
              required
            >
              <option value="">— Select new security —</option>
              {securities.map((s) => (
                <option key={s.id} value={s.id}>{s.symbol} – {s.name}</option>
              ))}
            </select>
          </div>
        )}

        {needsAllocation && (
          <div className="space-y-1">
            <label className="text-xs font-medium">% of cost basis to new security (0–1)</label>
            <Input
              type="number"
              step="0.001"
              min="0.001"
              max="1"
              value={costBasisAllocationPct}
              onChange={(e) => setCostBasisAllocationPct(e.target.value)}
              placeholder="e.g. 0.3"
            />
            <p className="text-xs text-muted-foreground">Original holding keeps the rest of its basis.</p>
          </div>
        )}

        {needsCash && (
          <div className="space-y-1">
            <label className="text-xs font-medium">Cash per share received (optional)</label>
            <Input
              type="number"
              step="any"
              min="0"
              value={cashComponent}
              onChange={(e) => setCashComponent(e.target.value)}
              placeholder="e.g. 5.00"
            />
          </div>
        )}

        <div className="space-y-1 col-span-2 md:col-span-1">
          <label className="text-xs font-medium">Description (optional)</label>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Q4 stock dividend"
          />
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button type="submit" size="sm" disabled={saving}>
        {saving ? 'Saving…' : 'Record activity'}
      </Button>
    </form>
  )
}
