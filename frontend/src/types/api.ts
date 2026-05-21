export type {
  Account,
  AccountType,
  AuthUser,
  Contact,
  HoldingSnapshot,
  InvestmentActivity,
  Transaction,
  PortfolioSummary,
  Rule,
  Paginated,
  Security,
  SecurityPrice,
  StatementPreview,
} from '@cashflow/shared'

/** Response item from GET /api/recurring — one detected recurring merchant. */
export type RecurringItem = {
  merchant: string
  currency: string
  cadence: 'monthly' | 'weekly'
  occurrences: number
  avgAmount: number
  amountStability: number
  lastSeen: string
  nextExpected: string
  category: string | null
}

/** Response shape for GET /api/recurring. */
export type RecurringResponse = {
  items: RecurringItem[]
  windowDays: number
  minOccurrences: number
}

/** Direction of a partner-balance settlement record. */
export type PartnerSettlementDirection = 'i_paid_partner' | 'partner_paid_me'

/** A single settlement row as returned by /api/settlements. */
export type PartnerSettlement = {
  id: number
  householdId: number
  contactId: number
  contactName: string | null
  direction: PartnerSettlementDirection
  currency: string
  amount: string
  settledDate: string
  notes: string | null
  createdAt: string
  updatedAt: string
}

/** Response shape for GET /api/settlements. */
export type PartnerSettlementsResponse = {
  data: PartnerSettlement[]
}

/** POST /api/settlements body shape. */
export type PartnerSettlementInput = {
  contactId: number
  direction: PartnerSettlementDirection
  currency: string
  amount: number
  settledDate: string
  notes?: string | null
}

/**
 * Filter shape accepted by POST /api/transactions/bulk-patch-filter. Mirrors
 * the subset of GET /api/transactions query params relevant for narrowing
 * the bulk-apply scope. Field names match the backend query helper.
 */
export type TransactionFilterPayload = {
  accountId?: number
  reviewFlag?: boolean
  currency?: string
  category?: string
  importBatch?: string
  dateFrom?: string
  dateTo?: string
}

/**
 * Patch shape for transaction bulk operations. Mirrors the per-row PATCH
 * body but limited to fields a household-wide override can sensibly set.
 */
export type TransactionBulkPatch = {
  categoryOverride?: string
  businessOverride?: boolean
  splitOverride?: 'me' | 'partner' | 'shared'
  pctMeOverride?: number
  pctPartnerOverride?: number
  ownershipType?: 'me' | 'partner' | 'shared' | 'contact'
  ownershipContactId?: number | null
  reviewFlag?: boolean
}

/** Request body for POST /api/transactions/bulk-patch-filter. */
export type BulkPatchFilterRequest = {
  filter: TransactionFilterPayload
  patch: TransactionBulkPatch
}

/** Success body for POST /api/transactions/bulk-patch-filter. */
export type BulkPatchFilterResponse = {
  updated: number
  ids: number[]
}
