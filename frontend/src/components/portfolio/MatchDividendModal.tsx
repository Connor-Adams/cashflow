import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { getJson, postJson } from '../../lib/api'
import { formatMoney } from '../../lib/formatMoney'
import { useToast } from '@/components/ui/toast'
import type { DividendCandidate, DividendCandidatesResponse, DividendRow } from '../../types/api'

type Props = {
  dividend: DividendRow
  onClose: () => void
  onMatched: () => void
}

export function MatchDividendModal({ dividend, onClose, onMatched }: Props) {
  const { showToast } = useToast()
  const [candidates, setCandidates] = useState<DividendCandidate[]>([])
  const [expectedAmount, setExpectedAmount] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [wrongTxWarning, setWrongTxWarning] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void getJson<DividendCandidatesResponse>(`/api/dividends/${dividend.id}/candidates`)
      .then((res) => {
        if (cancelled) return
        setCandidates(res.candidates)
        setExpectedAmount(res.expectedAmount)
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setErr(e instanceof Error ? e.message : 'Failed to load candidates')
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [dividend.id])

  const selectedCandidate = candidates.find((c) => c.id === selected)

  const looksWrong = selectedCandidate != null && (
    selectedCandidate.amount < 0
  )

  const handleConfirm = async () => {
    if (selected == null) return
    if (looksWrong && !wrongTxWarning) {
      setWrongTxWarning(true)
      return
    }
    setSaving(true)
    try {
      await postJson(`/api/dividends/${dividend.id}/match`, { transactionId: selected })
      const label = selectedCandidate
        ? `${selectedCandidate.merchantClean || selectedCandidate.merchantRaw} on ${selectedCandidate.date}`
        : `#${selected}`
      showToast({ title: `Matched to ${label}.`, variant: 'success' })
      onMatched()
    } catch (e) {
      showToast({ title: "Couldn't update dividend match. Try again.", variant: 'error' })
      setSaving(false)
      setWrongTxWarning(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Match dividend"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <Card className="w-full max-w-lg p-5 max-h-[80vh] flex flex-col">
        <h2 className="mb-1 text-lg font-semibold">Match dividend</h2>
        <p className="muted mb-3 text-sm">
          Choose the transaction that received this dividend payment.
        </p>
        {expectedAmount != null && (
          <p className="text-sm mb-3">
            Expected amount: <strong>{formatMoney(expectedAmount, dividend.currency)}</strong>
            {' '}(ex-div {dividend.exDividendDate}
            {dividend.paymentDate ? ` · pay ${dividend.paymentDate}` : ''})
          </p>
        )}

        {loading && <p className="muted">Loading candidates…</p>}
        {err && <p className="error">{err}</p>}

        {!loading && !err && candidates.length === 0 && (
          <p className="muted">No candidate transactions found in the ±30 day window.</p>
        )}

        {!loading && candidates.length > 0 && (
          <div className="overflow-y-auto flex-1 border rounded divide-y">
            {candidates.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => { setSelected(c.id); setWrongTxWarning(false) }}
                className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                  selected === c.id ? 'bg-accent' : 'hover:bg-muted/50'
                }`}
              >
                <div className="flex justify-between">
                  <span className="font-medium">{c.merchantClean || c.merchantRaw}</span>
                  <span className={c.amount >= 0 ? 'text-green-600' : 'text-destructive'}>
                    {formatMoney(c.amount, c.currency)}
                  </span>
                </div>
                <div className="text-muted-foreground">{c.date}</div>
              </button>
            ))}
          </div>
        )}

        {wrongTxWarning && (
          <p className="text-sm text-destructive mt-2" role="alert">
            This transaction doesn't look like a dividend (debit / wrong account). Continue?
          </p>
        )}

        {err == null && (
          <div className="flex justify-end gap-2 pt-3">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button
              type="button"
              disabled={selected == null || saving}
              onClick={() => void handleConfirm()}
            >
              {saving ? 'Matching…' : wrongTxWarning ? 'Confirm anyway' : 'Match'}
            </Button>
          </div>
        )}
      </Card>
    </div>
  )
}
