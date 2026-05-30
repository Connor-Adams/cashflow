/**
 * Frontend types for the reimbursement tracker (issue #216): the
 * /api/reimbursements/* collection and the per-transaction
 * POST /api/transactions/:id/reimbursable shortcut. Kept separate from
 * `types/api.ts` so a later move into `@cashflow/shared` is a straight rename.
 */

export type ReimbursementStatus = 'expected' | 'received' | 'overdue' | 'waived'

export interface ReimbursementTransactionView {
  id: number
  date: string
  merchant: string | null
  amount: string
  currency: string
}

export interface ReimbursementContactView {
  id: number
  name: string
}

export interface ReimbursementView {
  id: number
  householdId: number
  transactionId: number
  contactId: number | null
  partyName: string | null
  partyLabel: string
  amount: string
  currency: string
  dueDate: string | null
  status: ReimbursementStatus
  effectiveStatus: ReimbursementStatus
  isOverdue: boolean
  daysUntilDue: number | null
  repaymentTransactionId: number | null
  receivedAt: string | null
  notes: string | null
  createdAt: string | null
  updatedAt: string | null
  contact?: ReimbursementContactView | null
  transaction?: ReimbursementTransactionView | null
  repaymentTransaction?: ReimbursementTransactionView | null
}

export interface ReimbursementListResponse {
  data: ReimbursementView[]
  count: number
  today: string
}

export interface ReimbursementItemResponse {
  data: ReimbursementView
}

export interface ReimbursementSummaryGroup {
  key: string
  partyLabel: string
  contactId: number | null
  currency: string
  outstanding: string
  received: string
  counts: {
    expected: number
    overdue: number
    received: number
    waived: number
    total: number
  }
}

export interface ReimbursementSummaryResponse {
  groups: ReimbursementSummaryGroup[]
  outstandingByCurrency: Record<string, string>
  overdueCount: number
  totalCount: number
  today: string
}

export interface RepaymentCandidate {
  transactionId: number
  score: number
  amountCloseness: number
  dateProximity: number
  amount: string
  currency: string
  date: string
  merchant: string | null
}

export interface RepaymentCandidatesResponse {
  data: RepaymentCandidate[]
  count: number
}
