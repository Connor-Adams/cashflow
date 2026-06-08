import { useCallback, useEffect, useState } from 'react'
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { getJson, postJson } from '../../lib/api'
import type {
  DividendCandidate,
  DividendCandidatesResponse,
  DividendReconciliationRow,
} from '../../types/api'

type Props = {
  /** The unmatched reconciliation row being matched, or null when closed. */
  reconciliation: DividendReconciliationRow | null
  onOpenChange: (open: boolean) => void
  /** Called after a successful match so the parent can refetch + toast. */
  onMatched: (row: DividendReconciliationRow, candidate: DividendCandidate) => void
  onError: (message: string) => void
  /** Test seam: pre-supplied candidates skip the fetch. */
  initialCandidates?: DividendCandidate[]
}

function formatMoney(amount: number, currency: string | null): string {
  const sign = amount < 0 ? '-' : ''
  const abs = Math.abs(amount)
  const body = abs.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${sign}$${body}${currency ? ` ${currency}` : ''}`
}

export function MatchDividendModal({
  reconciliation,
  onOpenChange,
  onMatched,
  onError,
  initialCandidates,
}: Props) {
  const open = reconciliation != null
  const [candidates, setCandidates] = useState<DividendCandidate[]>(initialCandidates ?? [])
  const [loading, setLoading] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [confirmWrong, setConfirmWrong] = useState(false)

  const load = useCallback(async () => {
    if (!reconciliation || initialCandidates) return
    setLoading(true)
    try {
      const res = await getJson<DividendCandidatesResponse>(
        `/api/dividends/${reconciliation.reconciliationId}/candidates`,
      )
      setCandidates(res.candidates)
    } catch (e) {
      onError(e instanceof Error ? e.message : "Couldn't load candidate transactions.")
    } finally {
      setLoading(false)
    }
  }, [reconciliation, initialCandidates, onError])

  useEffect(() => {
    if (open) {
      setSelectedId(null)
      setConfirmWrong(false)
      if (initialCandidates) setCandidates(initialCandidates)
      else void load()
    }
  }, [open, load, initialCandidates])

  const selected = candidates.find((c) => c.id === selectedId) ?? null
  const selectedLooksWrong = selected != null && selected.warning != null

  const onConfirm = useCallback(async () => {
    if (!reconciliation || selected == null) return
    if (selectedLooksWrong && !confirmWrong) {
      // First click on a wrong-looking txn arms the confirm step.
      setConfirmWrong(true)
      return
    }
    setSubmitting(true)
    try {
      await postJson(`/api/dividends/${reconciliation.reconciliationId}/match`, {
        transactionId: selected.id,
      })
      onMatched(reconciliation, selected)
      onOpenChange(false)
    } catch (e) {
      onError(e instanceof Error ? e.message : "Couldn't update dividend match. Try again.")
    } finally {
      setSubmitting(false)
    }
  }, [reconciliation, selected, selectedLooksWrong, confirmWrong, onMatched, onOpenChange, onError])

  if (!open || !reconciliation) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange} className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Match dividend</DialogTitle>
        <DialogDescription>
          Choose the transaction that received this dividend payment.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="max-h-96 overflow-y-auto">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading transactions…</p>
        ) : candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No nearby transactions found on this account.
          </p>
        ) : (
          <ul className="flex flex-col gap-1" role="radiogroup" aria-label="Candidate transactions">
            {candidates.map((c) => {
              const isSelected = c.id === selectedId
              return (
                <li key={c.id}>
                  <Button
                    type="button"
                    variant={isSelected ? 'outline' : 'ghost'}
                    role="radio"
                    aria-checked={isSelected}
                    data-testid="dividend-candidate"
                    onClick={() => {
                      setSelectedId(c.id)
                      setConfirmWrong(false)
                    }}
                    className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm h-auto ${
                      isSelected
                        ? 'border-primary bg-muted'
                        : ''
                    }`}
                  >
                    <span className="flex flex-col">
                      <span className="font-medium">{c.merchant ?? 'Transaction'}</span>
                      <span className="text-xs text-muted-foreground">{c.date}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      {c.warning === 'debit' ? (
                        <Badge variant="destructive">Debit</Badge>
                      ) : null}
                      <span className={c.amount < 0 ? 'text-destructive' : ''}>
                        {formatMoney(c.amount, c.currency)}
                      </span>
                    </span>
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
        {selectedLooksWrong ? (
          <p
            className="mt-3 rounded-md border border-[var(--danger)] bg-destructive/10 px-3 py-2 text-xs text-destructive"
            role="alert"
            data-testid="dividend-wrong-tx-warning"
          >
            This transaction doesn&apos;t look like a dividend (debit / wrong account). Continue?
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={selected == null || submitting}
          onClick={onConfirm}
        >
          {selectedLooksWrong && confirmWrong ? 'Match anyway' : 'Match'}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
