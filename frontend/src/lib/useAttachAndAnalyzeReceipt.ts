import { useCallback, useState } from 'react'
import { postFormData, postJson } from './api'

type AnalyzeResult = { itemCount: number }

export function useAttachAndAnalyzeReceipt(onDone?: () => void | Promise<void>) {
  const [busyTxnId, setBusyTxnId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastItemCount, setLastItemCount] = useState<number | null>(null)

  const attachAndAnalyze = useCallback(async (file: File, txnId: number) => {
    setBusyTxnId(txnId)
    setError(null)
    setLastItemCount(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const { id } = await postFormData<{ id: number }>(`/api/transactions/${txnId}/receipts`, fd)
      const res = await postJson<AnalyzeResult>(`/api/receipts/${id}/analyze`, {})
      setLastItemCount(res.itemCount ?? 0)
      await onDone?.()
      return res
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Receipt attach/analyze failed')
      return null
    } finally {
      setBusyTxnId(null)
    }
  }, [onDone])

  return { attachAndAnalyze, busyTxnId, error, lastItemCount }
}
