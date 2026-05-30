import { useCallback, useEffect, useState } from 'react'
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { getJson, postJson } from '../../lib/api'
import { formatMoney } from '../../lib/formatMoney'
import type { DividendRow } from './DividendsTab'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CandidateTx = {
  id: number
  date: string
  amount: string
  currency: string
  merchantRaw: string
  merchantClean: string
  accountId: number
}

type CandidatesResponse = { candidates: CandidateTx[] }

// ---------------------------------------------------------------------------
// MatchDividendModal
// ---------------------------------------------------------------------------

type Props = {
  dividend: DividendRow
  onClose: () => void
  onMatched: () => void
}

export function MatchDividendModal({ dividend, onClose, onMatched }: Props) {
  const [candidates, setCandidates] = useState<CandidateTx[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [confirmWarn, setConfirmWarn] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const res = await getJson<CandidatesResponse>(`/api/dividends/${dividend.id}/candidates`)
      setCandidates(res.candidates)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load candidates')
    } finally {
      setLoading(false)
    }
  }, [dividend.id])

  useEffect(() => {
    void load()
  }, [load])

  function warnForCandidate(tx: CandidateTx): string | null {
    const amt = Number(tx.amount)
    if (amt <= 0) {
      return "This transaction doesn't look like a dividend (debit / wrong account). Continue?"
    }
    return null
  }

  function handleSelect(tx: CandidateTx) {
    const warn = warnForCandidate(tx)
    setSelected(tx.id)
    setConfirmWarn(warn)
  }

  async function handleConfirm() {
    if (selected == null) return
    setSaving(true)
    setErr(null)
    try {
      await postJson(`/api/dividends/${dividend.id}/match`, { transactionId: selected })
      onMatched()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to save match')
      setSaving(false)
    }
  }

  const expectedPerShare = Number(dividend.amount)

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogHeader>
        <DialogTitle>
          Match dividend — {dividend.symbol ?? `security ${dividend.securityId}`}
        </DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="muted mb-3">
          Payment date: {dividend.paymentDate ?? '—'} &middot;{' '}
          {formatMoney(expectedPerShare, dividend.currency)} / share
        </p>

        {err && <p className="error mb-2">{err}</p>}

        {loading ? (
          <p className="muted">Loading candidates…</p>
        ) : candidates.length === 0 ? (
          <p className="muted">
            No candidate transactions found within ±30 days of the payment date.
          </p>
        ) : (
          <div className="space-y-1 max-h-[50vh] overflow-y-auto">
            {candidates.map((tx) => {
              const isSelected = selected === tx.id
              const isDebit = Number(tx.amount) <= 0
              return (
                <button
                  key={tx.id}
                  type="button"
                  className={[
                    'w-full text-left rounded-lg border px-3 py-2 text-sm transition-colors',
                    isSelected
                      ? 'border-primary bg-primary/10'
                      : 'border-border hover:bg-muted/50',
                    isDebit ? 'opacity-60' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => handleSelect(tx)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{tx.merchantClean || tx.merchantRaw}</span>
                    <span
                      style={{
                        color: isDebit ? 'var(--accent-warm)' : 'var(--foreground)',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {formatMoney(Number(tx.amount), tx.currency)}
                    </span>
                  </div>
                  <div className="text-muted-foreground text-xs mt-0.5">
                    {tx.date}
                    {isDebit && (
                      <span
                        className="ml-2 px-1 rounded text-xs"
                        style={{
                          background: 'var(--accent-warm)',
                          color: '#fff',
                        }}
                      >
                        debit
                      </span>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {confirmWarn && selected != null && (
          <p
            className="mt-3 rounded-md border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--accent-warm)', color: 'var(--accent-warm)' }}
          >
            {confirmWarn}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() => void handleConfirm()}
          disabled={selected == null || saving}
        >
          {saving ? 'Saving…' : confirmWarn ? 'Continue anyway' : 'Confirm match'}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
