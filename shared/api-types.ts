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
  closedAt: string | null
  notes?: string | null       // present on GET /:id
  notesPreview?: string | null // present on GET / list
}

/**
 * Classified business purpose of a transfer pair (issue #222).
 *
 * - `owner_draw`: money moved from a business/corp account to a personal account
 *   for the owner's personal use. Treated as draws, not expenses.
 * - `owner_contribution`: money moved from a personal account into a
 *   business/corp account. Equity contribution, not income.
 * - `reimbursement`: business reimbursing a personal account for an
 *   out-of-pocket business expense.
 * - `investment`: cash moving to/from an investment account (e.g. brokerage
 *   funding). Does not contribute to spend or income.
 * - `internal`: money moving between accounts owned by the same entity
 *   (e.g. chequing → savings within the same person/corp).
 * - `income`: money from outside the household landing as a "transfer" by
 *   shape — payroll, dividend received from an external entity, etc. Only
 *   the inbound leg has a counterpart; this is the rare case where the user
 *   forces income classification on a money-movement event.
 */
export type TransferPurpose =
  | 'owner_draw'
  | 'owner_contribution'
  | 'reimbursement'
  | 'investment'
  | 'internal'
  | 'income'

export type AccountType =
  | 'checking'
  | 'savings'
  | 'credit_card'
  | 'investment'
  | 'loan'
  | 'cash'
  | 'other'

export type TransactionStatus = 'pending' | 'posted' | 'cleared'

/**
 * Account statement record (issue #242). One row per statement period
 * (e.g. a single monthly credit-card statement). The reconciliation flow
 * compares `closingBalance` against the per-account sum of transactions
 * in the period window plus `openingBalance`.
 */
export type AccountStatement = {
  id: number
  householdId: number
  accountId: number
  createdByUserId: number | null
  visibility: 'private' | 'shared'
  /** YYYY-MM-DD (inclusive). */
  periodStart: string
  /** YYYY-MM-DD (inclusive). */
  periodEnd: string
  openingBalance: number
  closingBalance: number
  currency: string
  sourceFilename: string | null
  notes: string | null
  /** ISO timestamp; null when not yet reconciled. */
  reconciledAt: string | null
  varianceExplanation: string | null
  createdAt: string
  updatedAt: string
  account?: {
    id: number
    name: string
    shortCode: string | null
    defaultCurrency: string | null
  } | null
}

/**
 * Statement reconciliation math output (issue #242). Returned alongside
 * the statement on detail/patch/reconcile responses so the UI can render
 * variance and balance without re-deriving.
 */
export type StatementReconciliation = {
  expectedClosing: number
  variance: number
  transactionCount: number
  transactionTotal: number
  isBalanced: boolean
}

/** Transaction shape returned inside the statement detail payload. */
export type StatementTransaction = {
  id: number
  date: string
  amount: number
  currency: string
  merchantClean: string
  merchantRaw: string
  finalCategory: string | null
  txnType: string
  linkedTransactionId: number | null
  transferPurpose: TransferPurpose | null
  status: TransactionStatus
}

export type StatementDetailResponse = {
  data: AccountStatement
  reconciliation: StatementReconciliation
  transactions: StatementTransaction[]
}

export type StatementListResponse = {
  data: AccountStatement[]
  page: number
  pageSize: number
  total: number
}

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
  status: TransactionStatus
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
  /** Canonical brand name when the normalize stage recognised it (e.g. "Amazon", "Netflix") */
  merchantCanonical: string | null
  /** Detected transaction type from narrative + sign */
  txnType: 'purchase' | 'refund' | 'transfer' | 'payment' | 'fee' | 'interest' | 'reward' | 'unknown'
  /** Winning enrichment signal source for the auto_* fields */
  autoSource: string | null
  /** Confidence of the winning enrichment signal */
  autoConfidence: 'high' | 'medium' | 'low' | null
  /** Linked sibling transaction id (refund→original, transfer→sibling) */
  linkedTransactionId: number | null
  /**
   * Classified business purpose of a transfer pair. Set on both sides of a
   * linked transfer. Null until a user (or rule) classifies it.
   * @see issue #222
   */
  transferPurpose: TransferPurpose | null
  /** When the transfer pair was linked (manually or by enrichment). */
  transferLinkedAt: string | null
  /** True when the detect-recurring stage flagged this as a recurring/subscription charge */
  isRecurring: boolean
  /** Count of attached receipt files */
  receiptCount?: number
  /** Receipt extraction mismatches that need review */
  receiptWarnings?: string[]
  /**
   * Deterministic post-import confidence state (#214). NULL on legacy rows
   * imported before the classifier; one of 'clean' | 'needs_review' when
   * populated.
   */
  importConfidence?: 'clean' | 'needs_review' | null
  /**
   * JSON-encoded array of flag tokens fired by the classifier
   * (e.g. ["missing_category","needs_review"]). NULL when no flags fired.
   */
  importConfidenceFlags?: string | null
  /**
   * Source/dest counterparty extracted from the statement line for
   * checking/savings/cash accounts (e.g. "JANE DOE" from
   * "INTERAC E-TFR FROM JANE DOE"). NULL when no pattern matched or the
   * account is out of scope (#372).
   */
  counterpartyRaw: string | null
  /**
   * Optional FK to `contacts.id` when the user has promoted the raw
   * counterparty into a structured Contact. NULL until promoted.
   */
  counterpartyContactId: number | null
  account?: Pick<Account, 'id' | 'name' | 'shortCode'>
  /**
   * Labels applied to this transaction (issue #270). Present on list/detail
   * responses; an empty array when the transaction has no labels.
   */
  labels?: TransactionLabelRef[]
}

/**
 * Discrete flag tokens emitted by computeImportConfidence (#214). Frontend
 * uses these to render filter chips in the Review Inbox + tile breakdown on
 * the dashboard.
 */
export const IMPORT_CONFIDENCE_FLAG_TOKENS = [
  'needs_review',
  'missing_category',
  'missing_split',
  'likely_duplicate',
  'possible_refund_pair',
  'missing_receipt',
] as const

export type ImportConfidenceFlagToken =
  (typeof IMPORT_CONFIDENCE_FLAG_TOKENS)[number]

export type ImportHealthResponse = {
  total: number
  clean: number
  needsReview: number
  unknown: number
  /** 0..1 — share of CLASSIFIED rows that are clean. 0 when no classified rows. */
  cleanPercent: number
  byFlag: Partial<Record<ImportConfidenceFlagToken, number>>
  currency: string | null
}

export type EnrichmentSignal = {
  id: number
  transactionId: number
  source: string
  confidence: 'high' | 'medium' | 'low'
  fields: Record<string, unknown>
  rationale: string | null
  createdAt: string
}

/**
 * Per-field explanation of why a transaction has its current category, split,
 * business flag, notes, and review state. Issue #230.
 *
 * The backend route GET /api/transactions/:id/explanation returns this shape.
 * Dates are serialized as ISO-8601 strings over the wire (JSON has no Date).
 */
export type ExplanationSource =
  | 'rule'
  | 'manual'
  | 'ai'
  | 'import-default'
  | 'fallback'

export type ManualEditAttribution = {
  /** ISO-8601 timestamp of the row's most recent update. */
  at: string
  actorUserId: number | null
  actorDisplayName: string | null
}

export type AiSuggestionAttribution = {
  id: number
  /** ISO-8601 timestamp the suggestion was generated. */
  createdAt: string
  status: 'accepted' | 'edited'
  model: string | null
}

export type AppliedRuleAttribution = {
  id: number
  merchantPattern: string
  category: string | null
}

export type CategoryExplanation = {
  source: ExplanationSource
  value: string | null
  message: string
  autoValue?: string | null
  overrideValue?: string | null
  appliedRule?: AppliedRuleAttribution
  aiSuggestion?: AiSuggestionAttribution
  manualEdit?: ManualEditAttribution
  /** Human-readable autoSource token when source is 'import-default'. */
  autoSourceLabel?: string
  /** Free-text rationale carried from the underlying enrichment signal. */
  signalRationale?: string
}

export type SplitExplanation = {
  source: ExplanationSource
  value: string
  message: string
  autoValue?: string | null
  overrideValue?: string | null
  appliedRule?: AppliedRuleAttribution
  aiSuggestion?: AiSuggestionAttribution
  manualEdit?: ManualEditAttribution
  autoSourceLabel?: string
  signalRationale?: string
}

export type BusinessExplanation = {
  source: ExplanationSource
  value: boolean
  message: string
  autoValue?: string | null
  overrideValue?: string | null
  appliedRule?: AppliedRuleAttribution
  aiSuggestion?: AiSuggestionAttribution
  manualEdit?: ManualEditAttribution
  autoSourceLabel?: string
  signalRationale?: string
}

export type NotesExplanation = {
  source: 'manual' | 'none'
  value: string | null
  message: string
  manualEdit?: ManualEditAttribution
}

export type ReviewExplanation = {
  state: 'cleared' | 'needs-review' | 'never-flagged'
  /** ISO-8601 timestamp of the last review-state change, or null. */
  lastChangedAt: string | null
  message: string
}

export type TransactionExplanation = {
  transactionId: number
  category: CategoryExplanation
  split: SplitExplanation
  business: BusinessExplanation
  notes: NotesExplanation
  review: ReviewExplanation
}

export type EnrichmentStats = {
  total: number
  reviewFlagTrue: number
  reviewFlagFalse: number
  reviewedTrue: number
  bySource: Record<string, number>
  byConfidence: Record<string, number>
  byTxnType: Record<string, number>
  isRecurringCount: number
  refundLinkedCount: number
  transferLinkedCount: number
  topCanonicalMerchants: Array<{ name: string; count: number }>
  topRules: Array<{ ruleId: number; pattern: string; category: string | null; count: number }>
}

export type EnrichmentBackfillProgress =
  | {
      kind: 'progress'
      txnId: number
      merchantRaw: string
      merchantClean: string
      merchantCanonical: string | null
      txnType: string
      autoSource: string | null
      autoConfidence: string | null
      reviewFlagCleared: boolean
      signalsCount: number
    }
  | {
      kind: 'summary'
      processed: number
      updated: number
      reviewFlagCleared: number
      signalsWritten: number
      skipped: number
      durationMs: number
      dryRun: boolean
    }
  | { kind: 'error'; message: string; txnId?: number }

/**
 * NDJSON stream events for POST /api/transactions/counterparty/backfill
 * (issue #376). Mirrors EnrichmentBackfillProgress in shape so the UI can
 * reuse the same feed-rendering pattern.
 */
export type CounterpartyBackfillProgress =
  | {
      kind: 'progress'
      txnId: number
      merchantRaw: string
      counterpartyRaw: string | null
    }
  | {
      kind: 'summary'
      processed: number
      extracted: number
      skipped: number
      elapsedMs: number
      dryRun: boolean
    }
  | { kind: 'error'; message: string; txnId?: number }

export type CounterpartyBackfillStatus = {
  running: boolean
  lastRunAt: string | null
  nextAllowedAt: string | null
  lastSummary: {
    processed: number
    extracted: number
    elapsedMs: number
  } | null
  rateLimitMs: number
}

export type Contact = {
  id: number
  householdId: number
  name: string
  notes: string | null
  /**
   * #375 — flags the household's partner Contact. Drives the Partner
   * Fairness dashboard's partner_inflows / non_partner_inflows split.
   */
  isPartner: boolean
}

export type Category = {
  id: number
  householdId: number
  name: string
  icon: string | null
  createdAt: string
  updatedAt: string
}

/**
 * A free-text transaction label (issue #270). Household-scoped, max 32 chars,
 * case-insensitively unique per household. `usageCount` is the number of
 * transactions tagged with it; present on the GET /api/labels list response.
 */
export type Label = {
  id: number
  name: string
  usageCount?: number
}

/** The shape a transaction carries for each applied label (id + name only). */
export type TransactionLabelRef = {
  id: number
  name: string
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
  effectiveFrom: string | null
  effectiveTo: string | null
  usageCount?: number
  updatedAt?: string
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
  todayChangePct: number | null
  thirtyDayReturnPct: number | null
  weightPct: number | null
  yieldOnCostPct: number | null
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
  /** CAD-equivalent unified total via Bank of Canada daily rates. Null when any FX lookup fails. */
  unifiedTotal: {
    baseCurrency: 'CAD'
    marketValue: number
    ratesUsed: Array<{ from: string; to: string; rate: number; ratedDate: string }>
    todayChangePct: number | null
    todayChangeCad: number | null
  } | null
  recentActivities: InvestmentActivity[]
  quoteProvider: string
  quoteConfigured: boolean
}

/**
 * Per-bucket row in the allocation response. Percentages are computed
 * per-currency — never mix CAD and USD into one denominator.
 */
export type AllocationByAssetType = {
  assetType: string
  marketValue: number
  currency: string
  percentage: number
}

export type AllocationBySecurity = {
  securityId: number
  symbol: string
  name: string | null
  marketValue: number
  currency: string
  percentage: number
}

export type AllocationByAccount = {
  accountId: number
  accountName: string
  marketValue: number
  currency: string
  percentage: number
}

/** Response shape for GET /api/portfolio/allocation. */
export type PortfolioAllocation = {
  byAssetType: AllocationByAssetType[]
  bySecurity: AllocationBySecurity[]
  byAccount: AllocationByAccount[]
}

/** One month bucket of dividend + interest income. `month` is YYYY-MM. */
export type IncomeMonthRow = {
  month: string
  currency: string
  dividend: number
  interest: number
  total: number
}

export type IncomeSecurityRow = {
  securityId: number | null
  symbol: string | null
  currency: string
  dividend: number
  interest: number
  total: number
  activityCount: number
}

export type IncomeAccountRow = {
  accountId: number
  accountName: string
  currency: string
  dividend: number
  interest: number
  total: number
}

export type IncomeTotalsRow = {
  currency: string
  dividend: number
  interest: number
  total: number
}

/** Response shape for GET /api/portfolio/income. */
export type PortfolioIncome = {
  byMonth: IncomeMonthRow[]
  bySecurity: IncomeSecurityRow[]
  byAccount: IncomeAccountRow[]
  totals: IncomeTotalsRow[]
}

/** Latest-quote payload nested inside other portfolio DTOs. */
export type PortfolioLatestPrice = {
  price: number
  pricedAt: string
  provider: string
  currency: string
}

/** Per-account contribution to a cross-account aggregate. */
export type BySecurityAccountBreakdown = {
  accountId: number
  accountName: string
  quantity: number
  costBasis: number | null
  marketValue: number
}

export type BySecurityRow = {
  securityId: number
  symbol: string
  name: string | null
  assetType: string | null
  currency: string
  totalQuantity: number
  totalCostBasis: number | null
  totalMarketValue: number
  unrealizedGainLoss: number | null
  accountBreakdown: BySecurityAccountBreakdown[]
  latestPrice: PortfolioLatestPrice | null
  todayChangePct: number | null
  thirtyDayReturnPct: number | null
  weightPct: number | null
  totalReturnPct: number | null
}

/** Response shape for GET /api/portfolio/by-security. */
export type PortfolioBySecurity = {
  rows: BySecurityRow[]
  unifiedTotal: {
    baseCurrency: 'CAD'
    marketValue: number
    ratesUsed: Array<{ from: string; to: string; rate: number; ratedDate: string }>
    todayChangePct: number | null
    todayChangeCad: number | null
  } | null
}

/** Aggregate realized-gain row per currency. */
export type RealizedTotalsRow = {
  currency: string
  realizedGain: number
  eventCount: number
}

export type RealizedSecurityRow = {
  securityId: number
  symbol: string
  name: string | null
  currency: string
  realizedGain: number
  eventCount: number
}

export type RealizedEvent = {
  activityId: number
  securityId: number
  symbol: string
  tradeDate: string
  qtySold: number
  proceeds: number
  acbAtSale: number
  realizedGain: number
  currency: string
  accountId: number
  accountName: string
}

/** Response shape for GET /api/portfolio/realized. */
export type PortfolioRealized = {
  totals: RealizedTotalsRow[]
  bySecurity: RealizedSecurityRow[]
  events: RealizedEvent[]
}

/** One state in the per-account ACB timeline (after each buy/sell). */
export type AcbTimelineState = {
  asOf: string
  quantity: number
  totalCost: number
  acbPerUnit: number
}

/** One SELL event resolved against weighted-average ACB. */
export type AcbRealizedEvent = {
  activityId: number
  tradeDate: string
  qtySold: number
  proceeds: number
  acbPerUnitAtSale: number
  costRemoved: number
  realizedGain: number
  currency: string
}

export type AcbResult = {
  finalState: AcbTimelineState
  timeline: AcbTimelineState[]
  realizedEvents: AcbRealizedEvent[]
  realizedTotal: number
  currency: string
  warnings: string[]
}

export type PortfolioPerAccountDetail = {
  accountId: number
  accountName: string
  currentQuantity: number
  currentMarketValue: number
  currentCostBasis: number
  currentUnrealizedGainLoss: number | null
  acb: AcbResult
}

export type PortfolioSecurityHeader = {
  id: number
  symbol: string
  name: string | null
  assetType: string | null
  currency: string
}

export type PortfolioSecurityCombined = {
  currentQuantity: number
  currentMarketValue: number
  currentCostBasis: number
  realizedTotal: number
  income: { dividend: number; interest: number }
  currency: string
  todayChangePct: number | null
  thirtyDayReturnPct: number | null
  yieldOnCostPct: number | null
}

export type PortfolioSecurityActivity = {
  id: number
  accountId: number
  accountName: string
  activityType: string
  tradeDate: string
  settlementDate: string | null
  description: string
  quantity: number | null
  price: number | null
  amount: number | null
  fees: number | null
  currency: string
}

export type PortfolioSecurityHolding = {
  id: number
  accountId: number
  accountName: string
  statementDate: string
  quantity: number
  price: number | null
  marketValue: number | null
  costBasis: number | null
  unrealizedGainLoss: number | null
  currency: string
}

/** Response shape for GET /api/portfolio/security/:id. */
export type PortfolioSecurityDetail = {
  security: PortfolioSecurityHeader
  perAccount: PortfolioPerAccountDetail[]
  combined: PortfolioSecurityCombined
  activities: PortfolioSecurityActivity[]
  holdings: PortfolioSecurityHolding[]
  latestPrice: PortfolioLatestPrice | null
}

export type ExternalOrderItemView = {
  id: number;
  externalOrderId: number;
  title: string;
  quantity: number;
  unitPrice: string | null;
  totalPrice: string | null;
  inferredCategory: string | null;
  categoryOverride: string | null;
  businessUsePercent: string | null;
  businessUseOverride: string | null;
};

export type ExternalOrderView = {
  id: number;
  vendor: string;
  subtotal: string | null;
  tax: string | null;
  shipping: string | null;
  total: string | null;
  currency: string;
};

export type ReceiptWithItems = {
  id: number;
  transactionId: number;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  extractedNote: string | null;
  createdAt: string;
  externalOrderId: number | null;
  order: ExternalOrderView | null;
  items: ExternalOrderItemView[];
};

/**
 * Response shape for GET /api/ai/status. `openai` reflects whether the
 * server has an OpenAI key configured (and the caller is not a demo user).
 * `chat` is the UI-facing flag for chat availability; it now mirrors
 * `openai` (chat is always-on whenever a provider is configured) but is
 * kept as a separate field for backward compatibility with existing
 * callers.
 */
export type AiStatus = {
  openai: boolean
  chat: boolean
}

/** A persisted chat thread row (GET /api/chat/threads, /:id). */
export type ChatThread = {
  id: number
  userId: number
  title: string | null
  archivedAt: string | null
  lastMessageAt: string | null
  createdAt: string
  updatedAt: string
}

export type ChatMessageRole = 'user' | 'assistant' | 'tool'

/** Shape of an entry in `toolCalls` JSON column on assistant messages. */
export type ChatStoredToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** A persisted chat message row (GET /api/chat/threads/:id). */
export type ChatMessage = {
  id: number
  threadId: number
  role: ChatMessageRole
  contentText: string | null
  toolCalls: ChatStoredToolCall[] | null
  toolCallId: string | null
  toolName: string | null
  model: string | null
  promptTokens: number | null
  completionTokens: number | null
  latencyMs: number | null
  providerRequestId: string | null
  createdAt: string
}

export type ChatProposalKind =
  | 'transaction_edit'
  | 'bulk_patch'
  | 'rule_create'
  | 'rule_update'
  | 'rule_delete'

export type ChatProposalStatus = 'pending' | 'applied' | 'rejected' | 'expired'

/** A persisted chat proposal row (GET /api/chat/threads/:id, SSE proposal events). */
export type ChatProposal = {
  id: number
  threadId: number
  messageId: number
  kind: ChatProposalKind
  payload: Record<string, unknown>
  preview: Record<string, unknown>
  status: ChatProposalStatus
  expiresAt: string
  appliedAt: string | null
  appliedResult: Record<string, unknown> | null
  createdAt: string
}

/** Response shape for GET /api/chat/threads/:id. */
export type ChatThreadDetail = {
  thread: ChatThread
  messages: ChatMessage[]
  proposals: ChatProposal[]
}

/**
 * SSE event union streamed by POST /api/chat/threads/:id/messages.
 * Frontend hook decodes each `event:` + `data:` pair into one of these.
 */
export type ChatStreamEvent =
  | { type: 'assistant_token'; text: string }
  | { type: 'tool_call_start'; toolName: string; argsPreview: string }
  | { type: 'tool_call_result'; toolName: string; ok: boolean; preview: unknown }
  | {
      type: 'proposal'
      proposalId: number
      kind: ChatProposalKind
      preview: Record<string, unknown>
    }
  | { type: 'assistant_done'; messageId: number }
  | { type: 'error'; message: string; code?: string }

export type ClientLogLevel = 'debug' | 'info' | 'warn' | 'error'

export type ClientLogPayload = {
  level: ClientLogLevel
  event: string
  message?: string
  path?: string
  requestId?: string
  fields?: Record<string, unknown>
}

export type ItemRow = {
  id: number
  title: string
  qty: number
  unitPrice: number | null
  totalPrice: number | null
  taxShare: number
  currency: string
  categoryEffective: string | null
  categoryOverride: string | null
  businessUseEffective: boolean
  businessUseOverride: boolean | null
  order: {
    id: number
    vendor: string
  }
  receipt: {
    id: number
    date: string | null
    sourceTxnId: number | null
  }
}

export type ItemsListResponse = {
  items: ItemRow[]
  nextCursor: string | null
}

export type ItemAllocation = {
  itemId: number
  itemTotal: number
  allocatedTotal: number | null
  categoryBucket: string | null
  txnId: number | null
  txnAmount: number | null
  percentOfTxn: number | null
  linkedTxnIds: number[]
  currency: string
}

// Category icon names. MUST exactly match lucide-react exports — every
// name listed here is imported into the frontend bundle.
export const CATEGORY_ICON_NAMES = [
  'ShoppingCart',
  'ShoppingBag',
  'Utensils',
  'Coffee',
  'Pizza',
  'Beer',
  'Wine',
  'Home',
  'Bed',
  'Sofa',
  'Lightbulb',
  'Plug',
  'Wifi',
  'Phone',
  'Smartphone',
  'Tv',
  'Laptop',
  'Car',
  'Fuel',
  'Bus',
  'Train',
  'Plane',
  'Bike',
  'ParkingSquare',
  'Stethoscope',
  'Pill',
  'HeartPulse',
  'Dumbbell',
  'GraduationCap',
  'BookOpen',
  'Briefcase',
  'Building2',
  'PiggyBank',
  'Landmark',
  'CreditCard',
  'Banknote',
  'Wallet',
  'Receipt',
  'Gift',
  'PartyPopper',
  'Cake',
  'Baby',
  'PawPrint',
  'Flower2',
  'Trees',
  'Wrench',
  'Hammer',
  'Paintbrush',
  'Scissors',
  'Shirt',
  'Gem',
  'Camera',
  'Music',
  'Film',
  'Gamepad2',
  'Ticket',
  'Map',
  'Mountain',
  'Sun',
  'Cloud',
  'Umbrella',
  'Snowflake',
  'Flame',
  'Droplet',
  'Trash2',
  'Recycle',
  'Leaf',
  'Heart',
  'Star',
  'Sparkles',
  'Tag',
  'Bookmark',
  'Folder',
  'Box',
  'Package',
  'Truck',
  'HandCoins',
  'TrendingUp',
  'TrendingDown',
] as const

export type CategoryIconName = (typeof CATEGORY_ICON_NAMES)[number]

export function isCategoryIconName(value: unknown): value is CategoryIconName {
  return (
    typeof value === 'string' &&
    (CATEGORY_ICON_NAMES as readonly string[]).includes(value)
  )
}

export type PortfolioSparklinePoint = {
  date: string  // 'YYYY-MM-DD'
  close: number
}

export type PortfolioSparklines = {
  range: '30d'
  bySecurityId: Record<number, PortfolioSparklinePoint[]>
}

export type PortfolioByAccountTypeRow = {
  securityId: number
  symbol: string
  name: string | null
  assetType: string | null
  accountId: number
  accountName: string
  quantity: number
  currency: string
  marketValue: number
  marketValueCad: number | null
  costBasis: number | null
  unrealizedGainCad: number | null
  weightInBucketPct: number | null
  flags: Array<'us_withholding' | 'fixed_income_in_non_reg' | 'us_payer_in_tfsa'>
}

export type PortfolioByAccountTypeBucket = {
  taxStatus: 'registered_tfsa' | 'registered_rrsp' | 'registered_fhsa' | 'registered_rrif' | 'non_registered' | 'n_a'
  label: string
  accounts: Array<{ id: number; name: string; currency: string }>
  holdingsCount: number
  totalCadMV: number | null
  allocationByAssetType: Array<{ assetType: string | null; marketValueCad: number; percentage: number }>
  rows: PortfolioByAccountTypeRow[]
}

export type PortfolioByAccountTypeWarning = {
  kind: 'fixed_income_in_non_reg' | 'us_payer_in_tfsa'
  securityId: number
  symbol: string
  accountName: string
  text: string
}

export type PortfolioByAccountTypeHarvestCandidate = {
  securityId: number
  symbol: string
  accountId: number
  accountName: string
  unrealizedLossCad: number
  superficialLossWarning: boolean
  superficialLossDetail: string | null
}

export type PortfolioByAccountType = {
  buckets: PortfolioByAccountTypeBucket[]
  warnings: PortfolioByAccountTypeWarning[]
  harvestCandidates: PortfolioByAccountTypeHarvestCandidate[]
}

export type PortfolioForwardIncomeCadence =
  | 'monthly' | 'quarterly' | 'semiannual' | 'annual' | 'irregular' | 'none';

export type PortfolioForwardIncomeNextExDivEntry = {
  date: string;
  estimatedPerShare: number;
  estimatedTotal: number;
  kind: 'dividend' | 'interest';
};

export type PortfolioForwardIncomeRow = {
  securityId: number;
  symbol: string;
  name: string;
  assetType: string | null;
  currency: string;
  qty: number;
  currentMvNative: number;
  costBasisNative: number;
  annualDividendPerShare: number;
  annualInterestPerShare: number;
  projectedAnnualIncomeNative: number;
  projectedAnnualIncomeCad: number;
  forwardYieldPct: number;
  forwardYieldOnCostPct: number;
  cadenceLabel: PortfolioForwardIncomeCadence;
  cvPct: number | null;
  unreliable: boolean;
  nextExDivDates: PortfolioForwardIncomeNextExDivEntry[];
};

export type PortfolioForwardIncomeTaxBucket = {
  taxStatus:
    | 'registered_rrsp' | 'registered_tfsa' | 'registered_fhsa'
    | 'registered_rrif' | 'non_registered' | 'n_a';
  byCurrency: Array<{ currency: string; amount: number }>;
  totalCad: number;
};

export type PortfolioForwardIncomeAssetBucket = {
  assetType: string;
  byCurrency: Array<{ currency: string; amount: number }>;
  totalCad: number;
};

export type PortfolioForwardIncomeUpcomingEntry = {
  date: string;
  securityId: number;
  symbol: string;
  estimatedTotalNative: number;
  estimatedTotalCad: number;
  currency: string;
  kind: 'dividend' | 'interest';
};

export type PortfolioForwardIncomeHoldingWithoutHistory = {
  securityId: number;
  symbol: string;
  reason: 'no_dividend_history' | 'insufficient_history';
};

export type PortfolioForwardIncome = {
  totals: {
    projectedAnnualIncomeCad: number;
    projectedAnnualIncomeByCurrency: Array<{ currency: string; amount: number }>;
    forwardYieldPct: number;
    forwardYieldOnCostPct: number;
    computedAt: string;
    fxRateUsedAt: string;
  };
  rows: PortfolioForwardIncomeRow[];
  byTaxStatus: PortfolioForwardIncomeTaxBucket[];
  byAssetType: PortfolioForwardIncomeAssetBucket[];
  upcoming90d: PortfolioForwardIncomeUpcomingEntry[];
  caveats: {
    unreliableSecurityIds: number[];
    holdingsWithoutHistory: PortfolioForwardIncomeHoldingWithoutHistory[];
  };
};

export type PortfolioPerformanceRange = '1M' | '3M' | 'YTD' | '1Y' | 'All' | 'custom';

export type PortfolioPerformancePoint = {
  date: string;
  portfolioValueCad: number;
  benchmarkValueCad: number;
  isPartial: boolean;
};

export type PortfolioPerformanceStats = {
  twrPct: number;
  mwrPct: number | null;
  benchmarkTwrPct: number;
  vsBenchmarkDeltaPct: number;
  startDate: string;
  endDate: string;
  startValueCad: number;
  endValueCad: number;
  netCashFlowCad: number;
};

export type PortfolioPerformanceByAccount = {
  accountId: number;
  accountName: string;
  twrPct: number;
  endValueCad: number;
  weightInPortfolioPct: number;
};

export type PortfolioPerformanceCaveats = {
  partialDaysCount: number;
  missingDataReasons: string[];
  benchmarkSymbol: string;
  benchmarkIsPartial: boolean;
};

export type PortfolioPerformance = {
  range: PortfolioPerformanceRange;
  stats: PortfolioPerformanceStats;
  presetStats: {
    '1M': PortfolioPerformanceStats;
    '3M': PortfolioPerformanceStats;
    'YTD': PortfolioPerformanceStats;
    '1Y': PortfolioPerformanceStats;
    'All': PortfolioPerformanceStats;
  };
  series: PortfolioPerformancePoint[];
  byAccount: PortfolioPerformanceByAccount[];
  caveats: PortfolioPerformanceCaveats;
};

// ---------------------------------------------------------------------------
// Debt payoff planner (issue #202)
// ---------------------------------------------------------------------------

export type DebtPayoffStrategy = 'avalanche' | 'snowball' | 'custom'

/** A liability account joined with its debt profile + derived owed balance. */
export type DebtLiability = {
  accountId: number
  name: string
  accountType: string
  currency: string
  /** Amount currently owed, as a positive number. */
  balance: number
  /** APR as a percent (e.g. 19.99). */
  interestRate: number
  minimumPayment: number
  /** Optional owed-balance override; null when derived from transactions. */
  statementBalance: number | null
  /** Optional day-of-month (1-31) the payment is due. */
  dueDay: number | null
}

/** One debt's line within a payoff month. */
export type PayoffMonthDebtLine = {
  debtId: number
  payment: number
  interest: number
  principal: number
  endingBalance: number
}

/** One month of the amortization schedule. */
export type PayoffMonth = {
  month: number
  perDebt: PayoffMonthDebtLine[]
  totalPaid: number
  totalInterest: number
}

/** A single scheduled monthly debt outflow (for the forecast). */
export type PayoffScheduledPayment = {
  date: string
  amount: number
}

/** The full computed payoff plan returned by the debt endpoints. */
export type DebtPayoffPlan = {
  strategy: DebtPayoffStrategy
  /** Debt (account) ids in the order they are targeted. */
  order: number[]
  months: PayoffMonth[]
  /** payoffMonthByDebt[id] = 1-based month the debt cleared, or null. */
  payoffMonthByDebt: Record<number, number | null>
  totalMonths: number
  totalInterest: number
  totalPaid: number
  scheduledPayments: PayoffScheduledPayment[]
  /** True when minimum payments cannot keep pace with interest. */
  stalled: boolean
}

/** avalanche-vs-snowball comparison returned by GET /api/debt. */
export type DebtPayoffComparison = {
  avalanche: DebtPayoffPlan
  snowball: DebtPayoffPlan
  /** snowball.totalInterest - avalanche.totalInterest (>= 0). */
  interestSaved: number
}

/** Response shape of GET /api/debt. */
export type DebtOverview = {
  currency: string
  totalOwed: number
  totalMinimumPayment: number
  extraMonthlyPayment: number
  liabilities: DebtLiability[]
  comparison: DebtPayoffComparison | null
}

/** A persisted saved scenario row. */
export type DebtPayoffScenario = {
  id: number
  householdId: number
  userId: number | null
  name: string
  strategy: DebtPayoffStrategy
  extraMonthlyPayment: string
  payloadJson: string | null
  createdAt: string
  updatedAt: string
}

/** Response shape of POST /api/debt/scenarios and GET /api/debt/scenarios/:id. */
export type DebtScenarioResponse = {
  scenario: DebtPayoffScenario
  plan: DebtPayoffPlan
  liabilities?: DebtLiability[]
}

/** A liability profile row returned by PUT /api/debt/accounts/:accountId. */
export type DebtLiabilityProfile = {
  accountId: number
  interestRate: number
  minimumPayment: number
  statementBalance: number | null
  dueDay: number | null
}

// ---------------------------------------------------------------------------
// Credit-card payment planner (#243) — operational bill management.
// ---------------------------------------------------------------------------

/** How a planned card payment sizes its amount. */
export type CardPaymentStrategy = 'statement' | 'minimum' | 'current'

/** How much autopay draws each cycle. */
export type CardAutopayType = 'full' | 'minimum' | 'fixed'

/** One credit card returned by GET /api/credit-cards. */
export type CreditCard = {
  accountId: number
  name: string
  accountType: string
  currency: string
  /** Transaction-derived amount currently owed, as a positive number. */
  currentBalance: number
  /** User-entered statement-balance snapshot, or null. */
  statementBalance: number | null
  minimumPayment: number
  /** Day-of-month (1-31) the payment is due, or null. */
  dueDay: number | null
  /** YYYY-MM-DD the current statement closed, or null. */
  statementDate: string | null
  autopayEnabled: boolean
  autopayType: CardAutopayType | null
  autopayAmount: number | null
  /** The cash account the bill is paid from, or null. */
  paymentAccountId: number | null
  /** Next calendar due date derived from dueDay, or null. */
  nextDueDate: string | null
  /** Whole days until nextDueDate (>= 0), or null when no dueDay set. */
  daysUntilDue: number | null
  /** True when a payment is due within the warning window. */
  dueSoon: boolean
}

/** Response shape of GET /api/credit-cards. */
export type CreditCardsOverview = {
  currency: string
  asOfDate: string
  cards: CreditCard[]
}

/** The profile row returned by PUT /api/credit-cards/:accountId. */
export type CreditCardProfile = {
  accountId: number
  statementBalance: number | null
  minimumPayment: number
  dueDay: number | null
  statementDate: string | null
  autopayEnabled: boolean
  autopayType: CardAutopayType | null
  autopayAmount: number | null
  paymentAccountId: number | null
}

/** The planned-event summary returned by the payment / mark-paid endpoints. */
export type CardPaymentPlannedEvent = {
  id: number
  accountId: number | null
  type?: string
  name?: string
  amount?: string
  currency?: string
  expectedDate?: string
  source?: string
  status: string
  linkedTransactionId: number | null
}

/**
 * Safe-to-spend impact echoed back when a card payment is planned, so the UI
 * can warn without a follow-up request. A structural subset of the backend's
 * full safe-to-spend result (extra fields are ignored).
 */
export type CardSafeToSpendImpact = {
  currency: string
  value: number
  isNegative: boolean
}

/** Response shape of POST /api/credit-cards/:accountId/payment. */
export type CreditCardPaymentResponse = {
  plannedEvent: CardPaymentPlannedEvent
  safeToSpend: CardSafeToSpendImpact | null
}
