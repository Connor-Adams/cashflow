export type {
  Account,
  AccountType,
  AcbRealizedEvent,
  AcbResult,
  AcbTimelineState,
  AllocationByAccount,
  AllocationByAssetType,
  AllocationBySecurity,
  AuthUser,
  BySecurityAccountBreakdown,
  BySecurityRow,
  Category,
  Contact,
  EnrichmentBackfillProgress,
  EnrichmentSignal,
  EnrichmentStats,
  HoldingSnapshot,
  IncomeAccountRow,
  IncomeMonthRow,
  IncomeSecurityRow,
  IncomeTotalsRow,
  InvestmentActivity,
  PortfolioAllocation,
  PortfolioByAccountType,
  PortfolioByAccountTypeBucket,
  PortfolioByAccountTypeHarvestCandidate,
  PortfolioByAccountTypeRow,
  PortfolioByAccountTypeWarning,
  PortfolioBySecurity,
  PortfolioForwardIncome,
  PortfolioForwardIncomeAssetBucket,
  PortfolioForwardIncomeCadence,
  PortfolioForwardIncomeHoldingWithoutHistory,
  PortfolioForwardIncomeNextExDivEntry,
  PortfolioForwardIncomeRow,
  PortfolioForwardIncomeTaxBucket,
  PortfolioForwardIncomeUpcomingEntry,
  PortfolioIncome,
  PortfolioPerformance,
  PortfolioPerformanceByAccount,
  PortfolioPerformanceCaveats,
  PortfolioPerformancePoint,
  PortfolioPerformanceRange,
  PortfolioPerformanceStats,
  PortfolioLatestPrice,
  PortfolioPerAccountDetail,
  PortfolioRealized,
  PortfolioSecurityActivity,
  PortfolioSecurityCombined,
  PortfolioSecurityDetail,
  PortfolioSecurityHeader,
  PortfolioSecurityHolding,
  PortfolioSparklinePoint,
  PortfolioSparklines,
  PortfolioSummary,
  RealizedEvent,
  RealizedSecurityRow,
  RealizedTotalsRow,
  Rule,
  Paginated,
  Security,
  SecurityPrice,
  StatementPreview,
  Transaction,
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

// ---------- Partner Fairness Dashboard (GET /api/partner/*) -----------------
// Mirrors backend/src/summary/partnerFairness.ts. The backend uses the
// single-payer model where `partnerShare` on each transaction is what the
// partner owes me back; `balance` follows the same sign convention as
// /api/summary/partner: positive → partner owes me, negative → I owe partner.

/** One bucket of the per-currency category breakdown. */
export type PartnerFairnessCategoryBreakdown = {
  category: string
  sharedSpend: number
  myShare: number
  partnerShare: number
  transactionCount: number
}

/** One of the largest shared transactions surfaced by /partner/fairness. */
export type PartnerFairnessLargestTransaction = {
  txnId: number
  date: string
  merchant: string
  category: string | null
  amount: number
  myShare: number
  partnerShare: number
  ownershipType: string
  ownershipContactId: number | null
  contactName: string | null
}

/** Per-currency fairness summary. */
export type PartnerFairnessByCurrency = {
  currency: string
  sharedSpendTotal: number
  myShareTotal: number
  partnerShareTotal: number
  sharedTransactionCount: number
  currentMonthSharedSpend: number
  balance: number
  direction: 'partner_owes_me' | 'i_owe_partner' | 'even'
  paidMore: { youCovered: number; partnerCovered: number }
  categoryBreakdown: PartnerFairnessCategoryBreakdown[]
  largestShared: PartnerFairnessLargestTransaction[]
}

/** Response shape for GET /api/partner/fairness. */
export type PartnerFairnessResponse = {
  byCurrency: PartnerFairnessByCurrency[]
}

/** One point in the historical fairness trend. */
export type PartnerFairnessMonthlyPoint = {
  /** YYYY-MM */
  month: string
  currency: string
  sharedSpend: number
  myShare: number
  partnerShare: number
  settlementDelta: number
  netDelta: number
  cumulativeBalance: number
}

/** Response shape for GET /api/partner/monthly. */
export type PartnerFairnessMonthlyResponse = {
  points: PartnerFairnessMonthlyPoint[]
}

/** One settlement recommendation per currency. */
export type PartnerSettlementRecommendation = {
  currency: string
  amount: number
  direction: 'partner_pays_you' | 'you_pay_partner' | 'none'
  outstandingBalance: number
}

/** Response shape for GET /api/partner/settlement-recommendation. */
export type PartnerSettlementRecommendationResponse = {
  recommendations: PartnerSettlementRecommendation[]
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

/** Supported budget recurrence periods (matches BUDGET_TARGET_PERIODS on the server). */
export type BudgetPeriod = 'monthly' | 'weekly' | 'annual'

/**
 * Budget scope vocabulary. Cashflow's transaction model splits these
 * across visibility / ownership / business flags; the server maps a
 * `scope` value back to that combination when computing spend.
 */
export type BudgetScope = 'personal' | 'partner' | 'business' | 'household'

/**
 * One row from GET /api/budgets. Mirrors the BudgetTarget serializer in
 * backend/src/routes/budgets.ts — `amount` arrives as a string (decimal)
 * because the column is DECIMAL(14,4) and we want lossless transport. UI
 * code that needs arithmetic must coerce with `Number(...)`.
 *
 * `category` is `null` for "overall" budgets that aggregate every category
 * sharing the budget's currency.
 */
export type Budget = {
  id: number
  householdId: number
  category: string | null
  currency: string
  amount: string
  period: BudgetPeriod
  scope: BudgetScope
  rolloverEnabled: boolean
  createdAt: string
  updatedAt: string
}

/** Response shape for GET /api/budgets. */
export type BudgetsResponse = {
  data: Budget[]
}

/**
 * The "pacing state" classification surfaced by /api/budgets/status —
 * compares percentUsed against periodElapsedPercent. See backend
 * `pacingState` for the thresholds.
 */
export type BudgetPacingState = 'on-pace' | 'ahead' | 'behind' | 'over'

/**
 * One row from GET /api/budgets/progress and /api/budgets/status — combines
 * a budget with current spend for the active period. Amounts here are
 * pre-coerced to numbers by the backend so UI code can format/compare
 * directly. The pacing fields (`periodElapsedPercent` and `pacingState`)
 * are populated by both endpoints.
 */
export type BudgetProgress = {
  budgetId: number
  category: string | null
  currency: string
  target: number
  spent: number
  remaining: number
  percentUsed: number
  periodStart: string
  periodEnd: string
  scope: BudgetScope
  period: BudgetPeriod
  rolloverEnabled: boolean
  periodElapsedPercent: number
  pacingState: BudgetPacingState
}

/** Response shape for GET /api/budgets/progress. */
export type BudgetProgressResponse = {
  items: BudgetProgress[]
}

/** Response shape for GET /api/budgets/status — identical to /progress. */
export type BudgetStatusResponse = BudgetProgressResponse

/** POST/PUT /api/budgets body shape. */
export type BudgetInput = {
  category: string | null
  currency: string
  amount: number
  period?: BudgetPeriod
  scope?: BudgetScope
  rolloverEnabled?: boolean
}

/** One row in the GET /api/budgets/:id/exclusions response. */
export type BudgetExclusion = {
  id: number
  budgetId: number
  transactionId: number
  createdAt: string
}

export type BudgetExclusionsResponse = {
  data: BudgetExclusion[]
}

/**
 * Planned financial event kind. Mirrors `PlannedEventType` in the backend
 * model. Drives forecast direction (income flows in, expense/debt_payment
 * flow out, transfer/settlement are intra-system, savings is goal-directed).
 */
export type PlannedEventType =
  | 'income'
  | 'expense'
  | 'transfer'
  | 'settlement'
  | 'debt_payment'
  | 'savings'

/**
 * Where a planned event came from. `manual` is user-authored; the others
 * are system-generated and should typically be treated as read-only in the
 * UI until the originating subsystem is refactored.
 */
export type PlannedEventSource =
  | 'manual'
  | 'recurring_detection'
  | 'settlement'
  | 'debt'
  | 'goal'
  | 'system'

/**
 * Lifecycle. `planned` is the default; `posted` means the event has been
 * matched to an actual transaction via `linkedTransactionId`; `skipped` and
 * `ignored` distinguish one-time skip from a hard dismiss.
 */
export type PlannedEventStatus = 'planned' | 'posted' | 'skipped' | 'ignored'

/**
 * One row from GET /api/planned-events. Mirrors the PlannedEvent serializer
 * in `backend/src/routes/plannedEvents.ts` — `amount` arrives as a string
 * (DECIMAL(14,4)) for lossless transport; coerce with `Number(...)` for
 * arithmetic.
 */
export type PlannedEvent = {
  id: number
  userId: number
  householdId: number
  accountId: number | null
  type: PlannedEventType
  name: string
  amount: string
  currency: string
  /** YYYY-MM-DD. */
  expectedDate: string
  /** Optional RRULE or JSON blob; null = one-off. */
  recurrenceRule: string | null
  source: PlannedEventSource
  status: PlannedEventStatus
  linkedTransactionId: number | null
  notes: string | null
  createdAt: string
  updatedAt: string
}

/** Response shape for GET /api/planned-events. */
export type PlannedEventsResponse = {
  data: PlannedEvent[]
}

/** POST /api/planned-events body shape. */
export type PlannedEventInput = {
  type: PlannedEventType
  name: string
  amount: number
  currency: string
  expectedDate: string
  accountId?: number | null
  recurrenceRule?: string | null
  source?: PlannedEventSource
  status?: PlannedEventStatus
  linkedTransactionId?: number | null
  notes?: string | null
}

/** PUT /api/planned-events/:id body shape — every field optional. */
export type PlannedEventPatch = Partial<PlannedEventInput>

/**
 * Direction of a forecast occurrence — drives sign + colour in the UI.
 * 'neutral' covers intra-household transfers / partner settlements that
 * net to zero at the household level.
 */
export type ForecastEventDirection = 'in' | 'out' | 'neutral'

/**
 * Source of a forecast occurrence row in GET /api/forecast.events.
 * 'planned_event' came from the planned_events table; 'recurring_detection'
 * was inferred from transaction history.
 */
export type ForecastEventSource = 'planned_event' | 'recurring_detection'

/** One projected occurrence inside the forecast window. */
export type ForecastEvent = {
  date: string
  /** Always non-negative; sign comes from `direction`. */
  amount: number
  direction: ForecastEventDirection
  sourceType: ForecastEventSource
  sourceId: number
  sourceName: string
  accountId: number | null
}

/** One daily point on the projected balance line. */
export type ForecastDailyPoint = {
  date: string
  balance: number
}

/** Response shape for GET /api/forecast. */
export type ForecastResponse = {
  currency: string
  /** YYYY-MM-DD inclusive. */
  dateFrom: string
  /** YYYY-MM-DD inclusive. */
  dateTo: string
  openingBalance: number
  projectedClosingBalance: number
  lowestProjectedBalance: number
  lowestProjectedBalanceDate: string | null
  dailyPoints: ForecastDailyPoint[]
  events: ForecastEvent[]
}

export type AppConfig = {
  logoDevToken: string | null;
  quoteProviderConfigured: boolean;
};

export type BackfillStatus = {
  status: 'fresh' | 'stale' | 'never' | 'in_progress' | 'rate_limited';
  lastFetchedAt: string | null;
  nextRetryAt: string | null;
  coverageDays: number;
};

export type PortfolioSecurityPriceRow = {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  adjClose: number;
  volume: number | null;
};

export type PortfolioSecurityTrade = {
  date: string;
  type: 'buy' | 'sell';
  quantity: number;
  price: number | null;
  accountName: string;
};

export type PortfolioSecurityPrices = {
  securityId: number;
  symbol: string;
  currency: string;
  range: '1m' | '3m' | '1y' | '5y' | 'all';
  rows: PortfolioSecurityPriceRow[];
  trades: PortfolioSecurityTrade[];
  backfill: BackfillStatus;
};

export type PortfolioSecurityDividendEvent = {
  exDividendDate: string;
  paymentDate: string | null;
  recordDate: string | null;
  amount: number;
  currency: string;
};

export type PortfolioSecurityDividends = {
  securityId: number;
  currency: string;
  events: PortfolioSecurityDividendEvent[];
  backfill: BackfillStatus;
};

export type PortfolioSecurityOverview = {
  securityId: number;
  sector: string | null;
  industry: string | null;
  country: string | null;
  exchange: string | null;
  description: string | null;
  exDividendDate: string | null;
  recommendationKey: string | null;
  financialCurrency: string | null;
  regularMarketPrice: number | null;
  previousClose: number | null;
  marketCap: number | null;
  trailingPE: number | null;
  forwardPE: number | null;
  trailingEps: number | null;
  forwardEps: number | null;
  beta: number | null;
  dayLow: number | null;
  dayHigh: number | null;
  fiftyTwoWeekLow: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyDayAverage: number | null;
  twoHundredDayAverage: number | null;
  volume: number | null;
  averageVolume: number | null;
  averageVolume10days: number | null;
  sharesOutstanding: number | null;
  priceToBook: number | null;
  bookValue: number | null;
  dividendRate: number | null;
  dividendYield: number | null;
  fiveYearAvgDividendYield: number | null;
  payoutRatio: number | null;
  totalRevenue: number | null;
  revenuePerShare: number | null;
  grossMargins: number | null;
  operatingMargins: number | null;
  profitMargins: number | null;
  ebitdaMargins: number | null;
  returnOnAssets: number | null;
  returnOnEquity: number | null;
  totalCash: number | null;
  totalDebt: number | null;
  debtToEquity: number | null;
  freeCashflow: number | null;
  operatingCashflow: number | null;
  targetMeanPrice: number | null;
  targetHighPrice: number | null;
  targetLowPrice: number | null;
  recommendationMean: number | null;
  numberOfAnalystOpinions: number | null;
  // Crypto
  circulatingSupply: number | null;
  volume24Hr: number | null;
  cryptoStartDate: string | null;
  fromCurrency: string | null;
  // Fund / ETF
  fundFamily: string | null;
  fundCategory: string | null;
  fundLegalType: string | null;
  fundExpenseRatio: number | null;
  fundTotalAssets: number | null;
  fundYield: number | null;
  topHoldings: Array<{
    symbol: string | null;
    name: string | null;
    percent: number | null;
  }> | null;
  sectorWeightings: Record<string, number> | null;
  bondPosition: number | null;
  stockPosition: number | null;
  cashPosition: number | null;
  trailingReturn1y: number | null;
  trailingReturn3y: number | null;
  trailingReturn5y: number | null;
  trailingReturn10y: number | null;
  trailingReturnYtd: number | null;
  // Earnings forecast
  nextEarningsDate: string | null;
  nextEarningsIsEstimate: boolean | null;
  earningsEpsAvg: number | null;
  earningsEpsLow: number | null;
  earningsEpsHigh: number | null;
  earningsRevenueAvg: number | null;
  earningsRevenueLow: number | null;
  earningsRevenueHigh: number | null;
  earningsHistory: Array<{
    period: string | null;
    quarter: string | null;
    epsActual: number | null;
    epsEstimate: number | null;
    epsDifference: number | null;
    surprisePercent: number | null;
  }> | null;
  recommendationTrend: Array<{
    period: string | null;
    strongBuy: number | null;
    buy: number | null;
    hold: number | null;
    sell: number | null;
    strongSell: number | null;
  }> | null;
  upgradeDowngradeHistory: Array<{
    date: string | null;
    firm: string | null;
    fromGrade: string | null;
    toGrade: string | null;
    action: string | null;
  }> | null;
  metadataFetchedAt: string | null;
  backfill: BackfillStatus;
};

export type PortfolioSecurityNews = {
  securityId: number;
  items: Array<{
    uuid: string;
    title: string;
    publisher: string;
    link: string;
    publishedAt: string;
    thumbnailUrl: string | null;
    relatedTickers: string[];
  }>;
};

export type NetWorthBreakdownRow = {
  source: 'account' | 'portfolio';
  accountId: number | null;
  label: string;
  currency: string;
  native: number | null;
  cadValue: number | null;
  openingBalanceSet: boolean;
  dataQualityWarning?: 'asset_balance_negative';
};

export type NetWorthGap =
  | { date: string; currency: string; reason: 'fx_rate_unavailable' }
  | { date: string; currency: string; reason: 'price_unavailable'; securityId: number };

export type NetWorthCurrent = {
  asOf: string;
  baseCurrency: 'CAD';
  total: number;
  assetsTotal: number;
  liabilitiesTotal: number;
  breakdown: { assets: NetWorthBreakdownRow[]; liabilities: NetWorthBreakdownRow[] };
  fxRatesUsed: { from: string; to: 'CAD'; rate: number; ratedDate: string }[];
  partial: boolean;
  gaps: NetWorthGap[];
};

export type NetWorthSeriesPoint = {
  date: string;
  total: number;
  assetsTotal: number;
  liabilitiesTotal: number;
};

export type NetWorthSeries = {
  baseCurrency: 'CAD';
  granularity: 'monthly' | 'daily';
  points: NetWorthSeriesPoint[];
  partial: boolean;
  gaps: NetWorthGap[];
};
