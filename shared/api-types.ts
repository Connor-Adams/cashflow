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
}

export type AccountType =
  | 'checking'
  | 'savings'
  | 'credit_card'
  | 'investment'
  | 'loan'
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
  /** True when the detect-recurring stage flagged this as a recurring/subscription charge */
  isRecurring: boolean
  /** Count of attached receipt files */
  receiptCount?: number
  /** Receipt extraction mismatches that need review */
  receiptWarnings?: string[]
  account?: Pick<Account, 'id' | 'name' | 'shortCode'>
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

export type Contact = {
  id: number
  householdId: number
  name: string
  notes: string | null
}

export type Category = {
  id: number
  householdId: number
  name: string
  icon: string | null
  createdAt: string
  updatedAt: string
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
