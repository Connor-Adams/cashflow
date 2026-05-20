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
