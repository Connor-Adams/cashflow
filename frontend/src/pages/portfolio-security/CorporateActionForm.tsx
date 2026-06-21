/**
 * Manual corporate-action entry form (issue #301). Sits above the activity
 * timeline on the per-security drill. Lets the user record the four
 * corporate-action types whose ACB effect the import pipeline can't express:
 * dividend in kind, spin-off, merger, and return of capital.
 *
 * The type dropdown also lists the imported types (buy/sell/split/DRIP) so the
 * editor reads as the full activity vocabulary, but those are disabled here —
 * they arrive via import, not manual entry — and selecting one shows a hint.
 *
 * Validation mirrors the server's pure `validateCorporateAction`: allocation in
 * (0, 1], recipient required for spin-off/merger, positive shares/amount. Submit
 * is blocked while any inline error stands. On success the parent reloads the
 * drill so the on-read ACB derivation refreshes the cost-basis cards (AC #9).
 */
import { useEffect, useMemo, useState } from 'react'
import { Button, Card, Input, Label, NativeSelect } from '@connor-adams/designsystem'
import { SectionHeader } from '@/components/ui/section-header'
import { getJson, postJson } from '../../lib/api'
import type {
  CorporateActionType,
  CreateCorporateActionRequest,
  CreateCorporateActionResponse,
  PortfolioSecuritiesResponse,
  PortfolioSecurityListItem,
} from '../../types/api'

type AccountOption = { accountId: number; accountName: string }

// Display order + labels for the dropdown. The four imported types are listed
// (disabled) so the control reads as the complete activity vocabulary.
const IMPORTED_TYPES: { value: string; label: string }[] = [
  { value: 'buy', label: 'Buy (imported)' },
  { value: 'sell', label: 'Sell (imported)' },
  { value: 'split', label: 'Split (imported)' },
  { value: 'reinvestment', label: 'DRIP (imported)' },
]

const CORPORATE_TYPES: { value: CorporateActionType; label: string }[] = [
  { value: 'dividend_in_kind', label: 'Dividend in kind (stock dividend)' },
  { value: 'spin_off', label: 'Spin-off' },
  { value: 'merger', label: 'Merger / acquisition' },
  { value: 'return_of_capital', label: 'Return of capital' },
]

// Which fields each corporate-action type reveals. Drives conditional rendering
// and the help copy (issue "UX details").
const FIELD_SPEC: Record<
  CorporateActionType,
  {
    shares: boolean
    amount: boolean
    recipient: boolean
    allocation: boolean
    cash: boolean
    help: string
  }
> = {
  dividend_in_kind: {
    shares: true,
    amount: false,
    recipient: false,
    allocation: false,
    cash: false,
    help: 'Increases share count without taxable income.',
  },
  spin_off: {
    shares: true,
    amount: false,
    recipient: true,
    allocation: true,
    cash: false,
    help: 'Original holding keeps the rest of its basis.',
  },
  merger: {
    shares: true,
    amount: false,
    recipient: true,
    allocation: false,
    cash: true,
    help: 'Source holding is disposed; cash received counts as proceeds.',
  },
  return_of_capital: {
    shares: false,
    amount: true,
    recipient: false,
    allocation: false,
    cash: false,
    help: 'Reduces cost basis; not income.',
  },
}

const isCorporate = (t: string): t is CorporateActionType =>
  t in FIELD_SPEC

export function CorporateActionForm({
  securityId,
  accounts,
  onSubmitted,
}: {
  securityId: number
  accounts: AccountOption[]
  onSubmitted: () => void
}) {
  const [open, setOpen] = useState(false)
  const [activityType, setActivityType] = useState<string>('dividend_in_kind')
  const [accountId, setAccountId] = useState<number | ''>(
    accounts.length === 1 ? accounts[0].accountId : '',
  )
  const [tradeDate, setTradeDate] = useState('')
  const [shares, setShares] = useState('')
  const [amount, setAmount] = useState('')
  const [recipientSecurityId, setRecipientSecurityId] = useState<number | ''>('')
  const [allocation, setAllocation] = useState('')
  const [cash, setCash] = useState('')
  const [securities, setSecurities] = useState<PortfolioSecurityListItem[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const spec = isCorporate(activityType) ? FIELD_SPEC[activityType] : null

  // Recipient candidates only matter for spin-off / merger; fetch lazily once.
  useEffect(() => {
    if (!spec?.recipient || securities.length > 0) return
    let cancelled = false
    void getJson<PortfolioSecuritiesResponse>('/api/portfolio/securities')
      .then((r) => {
        if (!cancelled) setSecurities(r.securities)
      })
      .catch(() => {
        /* recipient list is best-effort; the picker just stays empty */
      })
    return () => {
      cancelled = true
    }
  }, [spec?.recipient, securities.length])

  // Pure client-side validation mirroring the server. Returns the first error
  // message, or null when the form is submittable.
  const validationError = useMemo<string | null>(() => {
    if (!isCorporate(activityType)) return 'Pick a corporate action to record.'
    if (accountId === '') return 'Pick an account.'
    if (!tradeDate) return 'Pick a date.'
    const sharesNum = Number(shares)
    const amountNum = Number(amount)
    const allocNum = Number(allocation)
    if (spec?.shares && !(shares !== '' && Number.isFinite(sharesNum) && sharesNum > 0)) {
      return 'Shares must be greater than 0.'
    }
    if (spec?.amount && !(amount !== '' && Number.isFinite(amountNum) && amountNum > 0)) {
      return 'Amount must be greater than 0.'
    }
    if (spec?.recipient && recipientSecurityId === '') {
      return 'Pick the new security.'
    }
    if (spec?.allocation) {
      if (!(allocation !== '' && Number.isFinite(allocNum)) || allocNum <= 0 || allocNum > 1) {
        return 'Allocation must be between 0 and 1.'
      }
    }
    return null
  }, [activityType, accountId, tradeDate, shares, amount, allocation, recipientSecurityId, spec])

  const recipientOptions = useMemo(
    () => [
      { value: '', label: 'Select a security…' },
      ...securities
        .filter((s) => s.id !== securityId)
        .map((s) => ({ value: String(s.id), label: s.symbol || s.name || `#${s.id}` })),
    ],
    [securities, securityId],
  )

  const reset = () => {
    setShares('')
    setAmount('')
    setRecipientSecurityId('')
    setAllocation('')
    setCash('')
    setServerError(null)
  }

  const submit = async () => {
    setServerError(null)
    setSuccess(null)
    if (validationError || !isCorporate(activityType) || accountId === '') return
    const body: CreateCorporateActionRequest = {
      accountId,
      securityId,
      activityType,
      tradeDate,
    }
    if (spec?.shares) body.quantity = Number(shares)
    if (spec?.amount) body.amount = Number(amount)
    if (spec?.recipient && recipientSecurityId !== '') {
      body.recipientSecurityId = recipientSecurityId
    }
    if (spec?.allocation) body.costBasisAllocationPct = Number(allocation)
    if (spec?.cash && cash !== '') body.cashComponent = Number(cash)

    setSubmitting(true)
    try {
      await postJson<CreateCorporateActionResponse>('/api/portfolio/activities', body)
      setSuccess('Corporate action recorded. Cost basis updated.')
      reset()
      onSubmitted()
    } catch (e) {
      setServerError(e instanceof Error ? e.message : 'Could not save the corporate action.')
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) {
    return (
      <Card className="mt-4">
        <div className="flex items-center justify-between">
          <SectionHeader
            title="Add corporate action"
            description="Record a dividend in kind, spin-off, merger, or return of capital."
          />
          <Button variant="outline" onClick={() => setOpen(true)}>
            Add corporate action
          </Button>
        </div>
      </Card>
    )
  }

  const typeNotManual = !isCorporate(activityType)

  return (
    <Card className="mt-4">
      <SectionHeader
        title="Add corporate action"
        description="Record a corporate action so your adjusted cost base stays correct."
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="ca-type">Activity type</Label>
          <NativeSelect
            id="ca-type"
            value={activityType}
            onChange={(e) => {
              setActivityType(e.target.value)
              reset()
            }}
            options={[
              ...CORPORATE_TYPES.map((t) => ({ value: t.value, label: t.label })),
              ...IMPORTED_TYPES,
            ]}
          />
        </div>

        <div>
          <Label htmlFor="ca-account">Account</Label>
          <NativeSelect
            id="ca-account"
            value={accountId === '' ? '' : String(accountId)}
            onChange={(e) =>
              setAccountId(e.target.value === '' ? '' : Number(e.target.value))
            }
            options={[
              { value: '', label: 'Select an account…' },
              ...accounts.map((a) => ({
                value: String(a.accountId),
                label: a.accountName,
              })),
            ]}
          />
        </div>
      </div>

      {typeNotManual ? (
        <p className="muted mt-3" role="note">
          Buy, sell, split, and DRIP rows come from imports — they can't be added
          here.
        </p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 mt-3">
            <div>
              <Label htmlFor="ca-date">Date</Label>
              <Input
                id="ca-date"
                type="date"
                value={tradeDate}
                onChange={(e) => setTradeDate(e.target.value)}
              />
            </div>

            {spec?.shares && (
              <div>
                <Label htmlFor="ca-shares">Shares received</Label>
                <Input
                  id="ca-shares"
                  type="number"
                  inputMode="decimal"
                  value={shares}
                  onChange={(e) => setShares(e.target.value)}
                />
              </div>
            )}

            {spec?.amount && (
              <div>
                <Label htmlFor="ca-amount">Amount returned</Label>
                <Input
                  id="ca-amount"
                  type="number"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
            )}

            {spec?.recipient && (
              <div>
                <Label htmlFor="ca-recipient">New security</Label>
                <NativeSelect
                  id="ca-recipient"
                  value={recipientSecurityId === '' ? '' : String(recipientSecurityId)}
                  onChange={(e) =>
                    setRecipientSecurityId(
                      e.target.value === '' ? '' : Number(e.target.value),
                    )
                  }
                  options={recipientOptions}
                />
              </div>
            )}

            {spec?.allocation && (
              <div>
                <Label htmlFor="ca-allocation">
                  % of cost basis allocated to new security (0–1)
                </Label>
                <Input
                  id="ca-allocation"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  value={allocation}
                  onChange={(e) => setAllocation(e.target.value)}
                />
              </div>
            )}

            {spec?.cash && (
              <div>
                <Label htmlFor="ca-cash">Cash per share received (optional)</Label>
                <Input
                  id="ca-cash"
                  type="number"
                  inputMode="decimal"
                  value={cash}
                  onChange={(e) => setCash(e.target.value)}
                />
              </div>
            )}
          </div>

          {spec && (
            <p className="muted mt-2">{spec.help}</p>
          )}

          {validationError && (
            <p className="error mt-2" role="alert">
              {validationError}
            </p>
          )}
          {serverError && (
            <p className="error mt-2" role="alert">
              {serverError}
            </p>
          )}
          {success && (
            <p className="mt-2" role="status">
              {success}
            </p>
          )}
        </>
      )}

      <div className="flex gap-2 mt-4">
        <Button
          onClick={submit}
          disabled={submitting || typeNotManual || validationError != null}
        >
          {submitting ? 'Saving…' : 'Save corporate action'}
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            setOpen(false)
            reset()
            setSuccess(null)
          }}
        >
          Cancel
        </Button>
      </div>
    </Card>
  )
}
