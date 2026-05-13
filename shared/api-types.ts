/** API DTOs shared by backend serialization and frontend consumers. */

export type Account = {
  id: number
  name: string
  owner: string
  householdId: number | null
  ownerUserId: number | null
  visibility: 'private' | 'shared'
  accountType: AccountType
  shortCode: string | null
  defaultCurrency: string | null
}

export type AccountType =
  | 'checking'
  | 'savings'
  | 'credit_card'
  | 'investment'
  | 'cash'
  | 'other'

export type Transaction = {
  id: number
  accountId: number
  householdId: number | null
  createdByUserId: number | null
  visibility: 'private' | 'shared'
  ownershipType: 'me' | 'partner' | 'shared' | 'contact'
  ownershipContactId: number | null
  importBatch: string
  date: string
  merchantRaw: string
  merchantClean: string
  amount: number
  currency: string
  notes: string | null
  sourceReference: string | null
  sourceRowFingerprint: string
  appliedRuleId: number | null
  autoCategory: string | null
  categoryOverride: string | null
  finalCategory: string | null
  autoBusiness: boolean | null
  businessOverride: boolean | null
  finalBusiness: boolean
  autoSplitType: string | null
  splitOverride: string | null
  finalSplitType: string
  autoPctMe: number | null
  pctMeOverride: number | null
  finalPctMe: number | null
  autoPctPartner: number | null
  pctPartnerOverride: number | null
  finalPctPartner: number | null
  myShareAmount: number
  partnerShareAmount: number
  businessAmount: number
  reviewFlag: boolean
  reviewedAt: string | null
  /** Count of attached receipt files */
  receiptCount?: number
  /** Receipt extraction mismatches that need review */
  receiptWarnings?: string[]
  account?: Pick<Account, 'id' | 'name' | 'shortCode'>
}

export type Contact = {
  id: number
  householdId: number
  name: string
  notes: string | null
}

export type AuthUser = {
  id: number
  email: string
  displayName: string
  globalRole: 'user' | 'superadmin'
  household: {
    id: number
    name: string
    role: string
  } | null
}

export type Rule = {
  id: number
  merchantPattern: string
  matchKind: string
  priority: number
  category: string | null
  isBusiness: boolean
  splitType: string
  pctMe: string | null
  pctPartner: string | null
  usageCount?: number
}

export type Paginated<T> = {
  data: T[]
  page: number
  pageSize: number
  total: number
}

export type Security = {
  id: number
  symbol: string
  name: string | null
  assetType: string | null
  currency: string
}

export type SecurityPrice = {
  id: number
  provider: string
  symbol: string
  pricedAt: string
  price: number | null
  currency: string
  fetchedAt: string
}

export type InvestmentActivity = {
  id: number
  accountId: number
  securityId: number | null
  activityType: string
  tradeDate: string
  settlementDate: string | null
  description: string
  quantity: number | null
  price: number | null
  amount: number | null
  fees: number | null
  currency: string
  sourceReference: string | null
  importBatch: string
  security: Security | null
}

export type HoldingSnapshot = {
  id: number
  accountId: number
  securityId: number
  statementDate: string
  quantity: number
  price: number | null
  marketValue: number
  importedMarketValue: number | null
  costBasis: number | null
  unrealizedGainLoss: number | null
  currency: string
  sourceReference: string | null
  importBatch: string
  security: Security | null
  latestPrice: SecurityPrice | null
}

export type StatementPreview = {
  previewToken: string
  fileName: string
  accountId: number
  householdId: number | null
  importBatch: string
  usedParser: 'csv' | 'ofx'
  usedProfileId?: string
  profileInferred?: boolean
  headers?: string[]
  previewRowLimit: number
  transactions: Array<{
    date: string
    merchantRaw: string
    merchantClean: string
    amount: number
    currency: string
    duplicate?: boolean
  }>
  investmentActivities: Array<{
    activityType: string
    tradeDate: string
    description: string
    security: { symbol: string; name: string | null } | null
    quantity: number | null
    price: number | null
    amount: number | null
    currency: string
    duplicate?: boolean
  }>
  holdings: Array<{
    statementDate: string
    security: { symbol: string; name: string | null }
    quantity: number
    price: number | null
    marketValue: number | null
    costBasis: number | null
    unrealizedGainLoss: number | null
    currency: string
    duplicate?: boolean
  }>
  warnings: string[]
  rowErrors: number
  parseErrors: { rowIndex: number; message: string }[]
  duplicateCounts: {
    transactions: number
    investmentActivities: number
    holdings: number
  }
  rows?: Array<
    | {
        rowIndex: number
        ok: true
        mapped: {
          date: string
          merchantClean: string
          amount: number
          currency: string
        }
      }
    | { rowIndex: number; ok: false; error: string }
  >
}

export type PortfolioSummary = {
  accounts: Account[]
  holdings: HoldingSnapshot[]
  totalsByCurrency: Array<{ currency: string; marketValue: number }>
  recentActivities: InvestmentActivity[]
  quoteProvider: string
  quoteConfigured: boolean
}

export type ClientLogLevel = 'debug' | 'info' | 'warn' | 'error'

export type ClientLogPayload = {
  level: ClientLogLevel
  event: string
  message?: string
  path?: string
  requestId?: string
  fields?: Record<string, unknown>
}
