import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { postJson } from '../../lib/api'
import { useToast } from '@/components/ui/toast'

const ACTIVITY_TYPES = [
  { value: 'dividend_in_kind', label: 'Dividend in kind (stock dividend)' },
  { value: 'spin_off', label: 'Spin-off' },
  { value: 'merger', label: 'Merger / acquisition' },
  { value: 'return_of_capital', label: 'Return of capital' },
] as const

type CorporateActionType = (typeof ACTIVITY_TYPES)[number]['value']

type Props = {
  securityId: number
  accountId: number
  currency: string
  onClose: () => void
  onSaved: () => void
}

export function AddCorporateActionModal({ securityId, accountId, currency, onClose, onSaved }: Props) {
  const { showToast } = useToast()
  const [activityType, setActivityType] = useState<CorporateActionType>('dividend_in_kind')
  const [tradeDate, setTradeDate] = useState('')
  const [quantity, setQuantity] = useState('')
  const [amount, setAmount] = useState('')
  const [recipientSecurityId, setRecipientSecurityId] = useState('')
  const [costBasisAllocationPct, setCostBasisAllocationPct] = useState('')
  const [cashComponent, setCashComponent] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const needsRecipient = activityType === 'spin_off' || activityType === 'merger'
  const needsAllocation = activityType === 'spin_off'
  const needsCash = activityType === 'merger'
  const needsAmount = activityType === 'return_of_capital'
  const needsQty = activityType !== 'return_of_capital'

  // Inline validation
  const validationError = (() => {
    if (!tradeDate) return 'Date is required.'
    if (needsQty && (!quantity || Number(quantity) <= 0)) return 'Shares received must be positive.'
    if (needsAmount && (!amount || Number(amount) <= 0)) return 'Amount returned must be positive.'
    if (needsRecipient && !recipientSecurityId.trim()) return 'Pick the new security (enter its ID).'
    if (needsAllocation) {
      const pct = Number(costBasisAllocationPct) / 100
      if (!costBasisAllocationPct || pct <= 0 || pct > 1) return 'Allocation must be between 0 and 100%.'
    }
    return null
  })()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (validationError) { setError(validationError); return }
    setError(null)
    setSaving(true)
    try {
      const alloc = needsAllocation ? String(Number(costBasisAllocationPct) / 100) : undefined
      await postJson('/api/corporate-actions', {
        activityType,
        securityId,
        accountId,
        tradeDate,
        currency,
        quantity: needsQty ? quantity : undefined,
        amount: needsAmount ? amount : undefined,
        recipientSecurityId: recipientSecurityId.trim() || undefined,
        costBasisAllocationPct: alloc,
        cashComponent: cashComponent.trim() || undefined,
        description: description.trim() || undefined,
      })
      showToast({ title: 'Corporate action recorded.', variant: 'success' })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save.')
      setSaving(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add corporate action"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <Card className="w-full max-w-md p-5">
        <h2 className="mb-4 text-lg font-semibold">Add corporate action</h2>
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3">
          <label className="block text-sm">
            Type
            <select
              value={activityType}
              onChange={(e) => setActivityType(e.target.value as CorporateActionType)}
              className="mt-1 block w-full rounded border px-2 py-1 text-sm"
            >
              {ACTIVITY_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </label>

          <label className="block text-sm">
            Date
            <input
              type="date"
              value={tradeDate}
              onChange={(e) => setTradeDate(e.target.value)}
              required
              className="mt-1 block w-full rounded border px-2 py-1 text-sm"
            />
          </label>

          {needsQty && (
            <label className="block text-sm">
              {activityType === 'dividend_in_kind' ? 'Shares received' : 'Shares received in new security'}
              <input
                type="number"
                min="0.000001"
                step="0.000001"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="mt-1 block w-full rounded border px-2 py-1 text-sm"
                placeholder="0"
              />
              {activityType === 'dividend_in_kind' && (
                <p className="text-xs text-muted-foreground mt-1">Increases share count without taxable income</p>
              )}
            </label>
          )}

          {needsAmount && (
            <label className="block text-sm">
              Amount returned ({currency})
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="mt-1 block w-full rounded border px-2 py-1 text-sm"
                placeholder="0.00"
              />
              <p className="text-xs text-muted-foreground mt-1">Reduces cost basis; not income.</p>
            </label>
          )}

          {needsRecipient && (
            <label className="block text-sm">
              New security ID
              <input
                type="number"
                value={recipientSecurityId}
                onChange={(e) => setRecipientSecurityId(e.target.value)}
                className="mt-1 block w-full rounded border px-2 py-1 text-sm"
                placeholder="Security ID from /portfolio"
              />
            </label>
          )}

          {needsAllocation && (
            <label className="block text-sm">
              % of cost basis allocated to new security (0–100)
              <input
                type="number"
                min="0.01"
                max="100"
                step="0.01"
                value={costBasisAllocationPct}
                onChange={(e) => setCostBasisAllocationPct(e.target.value)}
                className="mt-1 block w-full rounded border px-2 py-1 text-sm"
                placeholder="e.g. 30 for 30%"
              />
              <p className="text-xs text-muted-foreground mt-1">Original holding keeps the rest of its basis.</p>
            </label>
          )}

          {needsCash && (
            <label className="block text-sm">
              Cash per share received (optional, {currency})
              <input
                type="number"
                min="0"
                step="0.01"
                value={cashComponent}
                onChange={(e) => setCashComponent(e.target.value)}
                className="mt-1 block w-full rounded border px-2 py-1 text-sm"
                placeholder="0.00"
              />
            </label>
          )}

          <label className="block text-sm">
            Description (optional)
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-1 block w-full rounded border px-2 py-1 text-sm"
              placeholder="e.g. 5% stock dividend declared 2026-01-15"
            />
          </label>

          {(error ?? validationError) && (
            <p className="text-sm text-destructive" role="alert">{error ?? validationError}</p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving || !!validationError}>
              {saving ? 'Saving…' : 'Add activity'}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  )
}
