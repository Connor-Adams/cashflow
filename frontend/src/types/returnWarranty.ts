/**
 * Frontend types for /api/return-warranty/* and the per-transaction PATCH
 * endpoint introduced by issue #217. Kept separate from `types/api.ts` so a
 * later move into `@cashflow/shared` is a straight rename.
 */

export type ReceiptStatus = 'unknown' | 'have' | 'missing' | 'not_needed'

export interface ReturnWarrantyRowView {
  id: number
  date: string
  merchant: string
  amount: string
  currency: string
  finalCategory: string | null
  accountName: string | null
  returnDeadline: string | null
  warrantyEndDate: string | null
  receiptStatus: ReceiptStatus
  hasReceipt: boolean
  notes: string | null
  daysUntilReturnDeadline: number | null
  daysUntilWarrantyEnd: number | null
}

export interface ReturnWarrantyListResponse {
  data: ReturnWarrantyRowView[]
  count: number
  today: string
  /** Only set on /expiring-soon. */
  withinDays?: number
  /** Only set on /expiring-soon. */
  cutoff?: string
}

export interface ReturnMetadataView {
  transactionId: number | null
  returnDeadline: string | null
  warrantyEndDate: string | null
  notes: string | null
  receiptStatus: ReceiptStatus
  isWithinReturnWindow: boolean
  isWarrantyActive: boolean
  daysUntilReturnDeadline: number | null
  daysUntilWarrantyEnd: number | null
}

export interface ReturnMetadataPatchResponse {
  data: ReturnMetadataView
}
