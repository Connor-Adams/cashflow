/**
 * Frontend types for /api/large-purchases/* and the per-transaction PATCH
 * endpoint introduced by issue #244. Mirrors the returnWarranty types pattern.
 */

export type LargePurchaseReviewStatus = 'pending' | 'reviewed' | 'dismissed'

export interface LargePurchaseReviewView {
  transactionId: number | null
  status: LargePurchaseReviewStatus
  categoryConfirmed: boolean | null
  businessRelevant: boolean | null
  receiptConfirmed: boolean | null
  warrantyTracked: boolean | null
  reimbursementTracked: boolean | null
  notes: string | null
  reviewedAt: string | null
}

export interface LargePurchaseRowView {
  id: number
  date: string
  merchant: string
  amount: string
  currency: string
  finalCategory: string | null
  accountName: string | null
  review: LargePurchaseReviewView
}

export interface LargePurchaseListResponse {
  data: LargePurchaseRowView[]
  count: number
  threshold: string
}

export interface LargePurchaseReviewPatchResponse {
  data: LargePurchaseReviewView
}
