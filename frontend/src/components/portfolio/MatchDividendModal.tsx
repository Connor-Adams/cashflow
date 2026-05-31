import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { getJson, postJson } from '@/lib/api'
import { formatMoney } from '@/lib/formatMoney'

type Dividend = {
  id: number
  securityId: number
  paymentDate: string | null
  exDividendDate: string
  amount: string
  currency: string
  security?: { id: number; symbol: string }
}

type Candidate = {
  transactionId: number
  date: string
  amount: number
  currency: string
  description: string
  accountId: number
  score: number
}

type Props = {
  dividend: Dividend
  onDone: () => void
  onCancel: () => void
}

export function MatchDividendModal({ dividend, onDone, onCancel }: Props) {
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)

  useEffect(() => {
    setLoading(true)
    getJson<Candidate[]>(`/api/dividends/${dividend.id}/candidates`)
      .then(setCandidates)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load candidates'))
      .finally(() => setLoading(false))
  }, [dividend.id])

  async function handleMatch() {
    if (selectedId == null) return
    setSubmitting(true)
    setError(null)
    try {
      await postJson(`/api/dividends/${dividend.id}/match`, { transactionId: selectedId })
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Match failed')
    } finally {
      setSubmitting(false)
    }
  }

  const symbol = dividend.security?.symbol ?? `security #${dividend.securityId}`
  const refDate = dividend.paymentDate ?? dividend.exDividendDate

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onCancel}
    >
      <div
        className="bg-background rounded-lg border shadow-lg w-full max-w-lg p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold">Match dividend to transaction</h2>
        <p className="text-sm text-muted-foreground">
          <strong>{symbol}</strong> · {formatMoney(Number(dividend.amount), dividend.currency)} ·{' '}
          {refDate}
        </p>

        {loading && <p className="text-sm text-muted-foreground">Loading candidates…</p>}
        {!loading && candidates.length === 0 && (
          <p className="text-sm text-muted-foreground italic">
            No matching transactions found within 30 days. Try importing the dividend transaction
            first.
          </p>
        )}
        {!loading && candidates.length > 0 && (
          <div className="divide-y divide-border border rounded-md max-h-64 overflow-y-auto">
            {candidates.map((c) => (
              <label
                key={c.transactionId}
                className="flex items-start gap-3 px-3 py-2.5 cursor-pointer hover:bg-muted/50"
              >
                <input
                  type="radio"
                  name="candidate"
                  value={c.transactionId}
                  checked={selectedId === c.transactionId}
                  onChange={() => setSelectedId(c.transactionId)}
                  className="mt-0.5"
                />
                <div className="text-sm flex-1 min-w-0">
                  <p className="font-medium">
                    {formatMoney(c.amount, c.currency)}{' '}
                    <span className="text-muted-foreground font-normal">· {c.date}</span>
                  </p>
                  <p className="text-muted-foreground truncate">{c.description || '—'}</p>
                </div>
              </label>
            ))}
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleMatch()}
            disabled={selectedId == null || submitting || loading}
          >
            {submitting ? 'Saving…' : 'Confirm match'}
          </Button>
        </div>
      </div>
    </div>
  )
}
