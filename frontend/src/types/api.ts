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
  ExplanationSource,
  ManualEditAttribution,
  AiSuggestionAttribution,
  AppliedRuleAttribution,
  CategoryExplanation,
  SplitExplanation,
  BusinessExplanation,
  NotesExplanation,
  ReviewExplanation,
  TransactionExplanation,
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
  AccountStatement,
  StatementReconciliation,
  StatementTransaction,
  StatementDetailResponse,
  StatementListResponse,
  Transaction,
  TransactionStatus,
  TransferPurpose,
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

/** Lifecycle state of a subscription row in the optimizer. */
export type SubscriptionStatus =
  | 'active'
  | 'cancelled'
  | 'ignored'
  | 'unknown'

/** One row of the /api/subscriptions response. */
export type Subscription = {
  id: number
  householdId: number
  merchantName: string
  normalizedName: string
  amount: string
  currency: string
  cadence: 'monthly' | 'weekly'
  lastChargeDate: string
  nextExpectedDate: string | null
  status: SubscriptionStatus
  category: string | null
  annualizedCost: string
  priceChangeDetected: boolean
  cancellationUrl: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
}

/** Response shape for GET /api/subscriptions. */
export type SubscriptionsResponse = {
  items: Subscription[]
}

/** PATCH /api/subscriptions/:id request body — only user-curated fields. */
export type SubscriptionPatch = {
  status?: SubscriptionStatus
  cancellationUrl?: string | null
  notes?: string | null
}

/** Response shape for GET /api/subscriptions/summary. */
export type SubscriptionsSummary = {
  totals: {
    active: number
    ignored: number
    cancelled: number
    unknown: number
    priceChangeDetected: number
  }
  byCurrency: Array<{
    currency: string
    activeCount: number
    monthlyCost: number
    annualCost: number
  }>
}

// -------- Money leaks dashboard (GET /api/money-leaks) -----------------
// Mirrors backend/src/money_leaks/detect.ts. Each leak row is detector
// output; identityKey + leakType are stable across reads so the UI can
// post dismissals without round-tripping through a numeric leak id.

/** Money-leak type emitted by the detectors. New types must be added in
 *  lockstep with MONEY_LEAK_TYPES on the backend. */
export type MoneyLeakType =
  | 'subscription_price_increase'
  | 'small_subscription'
  | 'recurring_fee'
  | 'duplicate_service'
  | 'delivery_fee_high'

export type MoneyLeakSeverity = 'low' | 'medium' | 'high'

/** One leak row as returned by GET /api/money-leaks. */
export type MoneyLeakItem = {
  leakType: MoneyLeakType
  identityKey: string
  title: string
  description: string
  currency: string
  monthlyImpact: number
  annualImpact: number
  severity: MoneyLeakSeverity
  meta: Record<string, unknown>
}

/** Response shape for GET /api/money-leaks. */
export type MoneyLeaksResponse = {
  items: MoneyLeakItem[]
  totals: {
    byCurrency: Array<{
      currency: string
      monthlyImpact: number
      annualImpact: number
      count: number
    }>
  }
}

/** One persisted dismissal row as returned by GET /api/money-leaks/dismissed. */
export type MoneyLeakDismissal = {
  id: number
  leakType: MoneyLeakType
  identityKey: string
  snapshot: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
}

/** Response shape for GET /api/money-leaks/dismissed. */
export type MoneyLeakDismissedResponse = {
  items: MoneyLeakDismissal[]
}

// -------- Explain this month report (GET /api/reports/explain-month) ----
// Mirrors backend/src/summary/explainMonth.ts. The deterministic engine
// produces a month-over-month breakdown by currency plus a flat list of
// findings (spend changes, missing receipts, subscription changes, review
// backlog, business summary). The aiSummary field is filled in by the
// route when `ai=true` and OpenAI is configured; otherwise it stays null.

export type ExplainMonthFindingKind =
  | 'spend_change'
  | 'missing_receipt'
  | 'subscription_change'
  | 'review_needed'
  | 'business_summary'

export type ExplainMonthSeverity = 'low' | 'medium' | 'high'

/** Filter payload backing each finding — the page translates it into the
 *  TransactionsPage URL params it natively understands. */
export type ExplainMonthTransactionFilter = {
  dateFrom?: string
  dateTo?: string
  category?: string
  merchant?: string
  businessOnly?: boolean
  reviewFlag?: boolean
  currency?: string
}

export type ExplainMonthFinding = {
  id: string
  kind: ExplainMonthFindingKind
  title: string
  summary: string
  currency: string
  monthlyImpact: number
  severity: ExplainMonthSeverity
  supportingTransactionIds: number[]
  transactionFilter: ExplainMonthTransactionFilter
  meta: Record<string, unknown>
}

export type ExplainMonthCategoryDelta = {
  category: string
  current: number
  previous: number
  delta: number
  deltaPct: number | null
}

export type ExplainMonthMonthOverMonth = {
  currency: string
  currentSpend: number
  previousSpend: number
  spendDelta: number
  currentIncome: number
  previousIncome: number
  incomeDelta: number
  netCurrent: number
  netPrevious: number
  netDelta: number
  byCategory: ExplainMonthCategoryDelta[]
}

export type ExplainMonthResponse = {
  month: string
  previousMonth: string
  monthOverMonth: ExplainMonthMonthOverMonth[]
  findings: ExplainMonthFinding[]
  aiSummary: string | null
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
  /**
   * #375 — sum of positive-amount rows whose counterparty Contact has
   * `isPartner=true`.
   */
  partnerInflows: number
  /**
   * #375 — sum of positive-amount rows whose counterparty is null or a
   * non-partner Contact (friend repaying lunch, side gig, family gift).
   */
  nonPartnerInflows: number
  balance: number
  direction: 'partner_owes_me' | 'i_owe_partner' | 'even'
  paidMore: { youCovered: number; partnerCovered: number }
  categoryBreakdown: PartnerFairnessCategoryBreakdown[]
  largestShared: PartnerFairnessLargestTransaction[]
}

/** Response shape for GET /api/partner/fairness. */
export type PartnerFairnessResponse = {
  byCurrency: PartnerFairnessByCurrency[]
  /**
   * #375 — echo of the toggle state the rollup was computed with. The
   * frontend uses this to keep the local switch in sync after a navigation
   * that bypasses the settings round-trip.
   */
  excludeNonPartnerInflows: boolean
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
  /** #375 — echo of the toggle state used to compute the trend. */
  excludeNonPartnerInflows: boolean
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
  /** #375 — echo of the toggle state used to compute the recommendation. */
  excludeNonPartnerInflows: boolean
}

// ---- Sankey visualization (issue #224) ---------------------------------

/** Classification of a node in the Sankey diagram — drives coloring. */
export type SankeyNodeKind =
  | 'income'
  | 'category'
  | 'business'
  | 'savings'
  | 'uncategorized'

export type SankeyNode = {
  name: string
  kind: SankeyNodeKind
}

export type SankeyLink = {
  source: number
  target: number
  value: number
}

/** Response shape for GET /api/summary/sankey. */
export type SankeyResponse = {
  currency: string | null
  totalIncome: number
  totalSpend: number
  transactionCount: number
  nodes: SankeyNode[]
  links: SankeyLink[]
  /** Every currency the household has at least one visible txn in. */
  availableCurrencies: string[]
  dateRange: { from: string | null; to: string | null }
}

export type SankeyDrilldownTransaction = {
  id: number
  date: string
  currency: string
  amount: number
  merchant: string
  finalCategory: string | null
  finalBusiness: boolean
  txnType: string | null
}

/** Response shape for GET /api/summary/sankey/source-transactions. */
export type SankeyDrilldownResponse = {
  edge: { source: number; target: number }
  transactionCount: number
  truncated: boolean
  transactions: SankeyDrilldownTransaction[]
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
  status?: import('@cashflow/shared').TransactionStatus
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
  /**
   * When true (issue #215) the budget's progress route subtracts the
   * linked-original-purchase amount of every refund that lands in the
   * current period — so a $200 jacket that was refunded in the same
   * window contributes $0 to the budget.
   */
  excludeRefundedPurchases: boolean
  /**
   * Percentages (1–500) at which the daily `budget_breach_check` cron fires
   * a proactive in-app notification (issue #268). Defaults to
   * `[80, 100, 120]`; an empty array disables alerts entirely for this
   * budget. Validated server-side: integers, 1≤n≤500, dedup+sort ascending.
   */
  alertThresholds: number[]
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
  /** Mirror of `Budget.excludeRefundedPurchases` for issue #215. */
  excludeRefundedPurchases?: boolean
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
  excludeRefundedPurchases?: boolean
  /**
   * See `Budget.alertThresholds` for the contract. Omitting the field keeps
   * the existing value on update, or applies server defaults on create.
   */
  alertThresholds?: number[]
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
 * Issue #215: response from GET /api/transactions/:id/refund-details.
 *
 * When `linked` is true and `original` is non-null, the refund row is
 * tied to an accessible original purchase the frontend can render inline.
 * `linked` true with `original` null means the link exists but the
 * original lies outside the caller's visible scope (still surfaced so the
 * UI shows "Linked to original you don't have access to" rather than
 * hallucinating an unlinked state).
 *
 * `partial` is true when |refund amount| < |original amount| (the refund
 * only returned part of the purchase).
 */
export type RefundDetailsResponse = {
  refundId: number
  linked: boolean
  partial: boolean | null
  original: {
    id: number
    date: string
    merchantClean: string
    merchantCanonical: string | null
    amount: number
    currency: string
    finalCategory: string | null
  } | null
}

/**
 * Issue #215: one row from GET /api/transactions/refund-suggestions, the
 * review queue. `linkedOriginal` is set when the refund has an auto-linked
 * original. `suggestions` contains any medium-confidence canonical-brand
 * matches the detector flagged for review. The UI uses both to render a
 * "confirm this match" / "switch to suggestion" / "unlink" affordance.
 */
export type RefundSuggestionRow = {
  refundId: number
  refundDate: string
  refundMerchantClean: string
  refundAmount: number
  refundCurrency: string
  autoSource: string | null
  autoConfidence: 'high' | 'medium' | 'low' | null
  reviewFlag: boolean
  linkedOriginal: {
    id: number
    date: string
    merchantClean: string
    amount: number
    currency: string
    finalCategory: string | null
  } | null
  suggestions: Array<{
    originalId: number
    originalDate: string
    originalMerchantClean: string
    originalAmount: number
    originalCurrency: string
    originalFinalCategory: string | null
    rationale: string | null
  }>
}

export type RefundSuggestionsResponse = {
  data: RefundSuggestionRow[]
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
 * One event row from GET /api/calendar/events. Mirrors `CalendarEventResponse`
 * in `backend/src/routes/calendar.ts`. A single `id` may appear multiple
 * times when its `recurrenceRule` produces multiple occurrences inside the
 * requested window — each occurrence has its own `eventDate`.
 */
export type CalendarEvent = {
  id: number
  /** Concrete YYYY-MM-DD this occurrence lands on. */
  eventDate: string
  type: PlannedEventType
  /** Human-readable label e.g. "Debt payment". */
  kindLabel: string
  /** Tailwind palette key e.g. "emerald". */
  categoryColor: string
  name: string
  /** DECIMAL string — coerce with Number() for arithmetic. */
  amount: string
  currency: string
  status: PlannedEventStatus
  /** Original anchor date; same as eventDate for non-recurring rows. */
  anchorDate: string
  recurrenceRule: string | null
  accountId: number | null
  linkedTransactionId: number | null
  notes: string | null
}

/** Response shape for GET /api/calendar/events. */
export type CalendarEventsResponse = {
  /** Echoed YYYY-MM-DD window start (clamped/defaulted server-side). */
  from: string
  /** Echoed YYYY-MM-DD window end. */
  to: string
  events: CalendarEvent[]
}

/**
 * Frontend mirror of backend `EVENT_CATEGORY_COLOR`. Tailwind v4 JIT needs
 * literal class names, so we store fully qualified Tailwind classes per
 * type for backgrounds, text, and dot accents. Backend ships the palette
 * key (`emerald`); we map it to ready-to-use class strings here.
 */
export const CALENDAR_EVENT_BG_CLASS: Record<PlannedEventType, string> = {
  income: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100',
  expense: 'bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-100',
  transfer: 'bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-100',
  settlement: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100',
  debt_payment: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-100',
  savings: 'bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-100',
}

export const CALENDAR_EVENT_DOT_CLASS: Record<PlannedEventType, string> = {
  income: 'bg-emerald-500',
  expense: 'bg-rose-500',
  transfer: 'bg-sky-500',
  settlement: 'bg-amber-500',
  debt_payment: 'bg-orange-500',
  savings: 'bg-violet-500',
}

/**
 * Financial goal lifecycle (issue #203). Mirrors backend FinancialGoalStatus.
 * - active: in progress, contributions count
 * - paused: user temporarily disabled contributions
 * - completed: archived, hidden from active views by default
 */
export type FinancialGoalStatus = 'active' | 'paused' | 'completed'

/**
 * One row from GET /api/goals. Mirrors the FinancialGoal serializer in
 * `backend/src/routes/goals.ts` — `targetAmount`, `currentAmount`, and
 * `monthlyContribution` arrive as strings (DECIMAL(14,4)) for lossless
 * transport; coerce with `Number(...)` for arithmetic.
 */
export type FinancialGoal = {
  id: number
  userId: number
  householdId: number
  name: string
  targetAmount: string
  currentAmount: string
  currency: string
  /** YYYY-MM-DD or null when no deadline. */
  targetDate: string | null
  /** User-declared monthly contribution intent; null = derive required. */
  monthlyContribution: string | null
  linkedAccountId: number | null
  priority: number
  status: FinancialGoalStatus
  notes: string | null
  createdAt: string
  updatedAt: string
}

/** Response shape for GET /api/goals. */
export type FinancialGoalsResponse = {
  data: FinancialGoal[]
}

/** POST /api/goals body shape. */
export type FinancialGoalInput = {
  name: string
  targetAmount: number
  currentAmount?: number
  currency: string
  targetDate?: string | null
  monthlyContribution?: number | null
  linkedAccountId?: number | null
  priority?: number
  status?: FinancialGoalStatus
  notes?: string | null
}

/** PUT /api/goals/:id body shape — every field optional. */
export type FinancialGoalPatch = Partial<FinancialGoalInput>

/**
 * GET /api/goals/:id/projection response. `requiredMonthlyContribution`
 * is the suggested monthly amount to hit `targetDate`; null when the goal
 * has no target_date or is already completed. `projectedCompletionDate` is
 * derived from the user's monthly_contribution intent.
 */
export type GoalProjectionStatus =
  | 'completed'
  | 'on_track'
  | 'ahead'
  | 'behind'
  | 'unfunded'
  | 'active'

export type GoalProjectionResponse = {
  goalId: number
  /** YYYY-MM-DD — the date the projection was computed against. */
  today: string
  remainingAmount: string
  progressPercent: number
  monthsRemaining: number | null
  requiredMonthlyContribution: string | null
  projectedCompletionDate: string | null
  status: GoalProjectionStatus
}

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

export type AuditLogEntry = {
  id: number;
  action: string;
  entityType: string;
  entityId: number | null;
  actorUserId: number | null;
  actorDisplayName: string | null;
  actorEmail: string | null;
  summary: string | null;
  before: unknown | null;
  after: unknown | null;
  metadata: unknown | null;
  createdAt: string;
};

export type AuditLogResponse = {
  total: number;
  limit: number;
  offset: number;
  items: AuditLogEntry[];
};

/**
 * Per-user safe-to-spend knobs (issue #199). Returned by both GET and
 * PATCH /api/settings/cashflow.
 */
export type CashflowSettings = {
  /** DECIMAL(14,4) string. */
  minimumCashBuffer: string;
  safeToSpendWindowDays: number;
  includeCreditCardBalance: boolean;
  includeGoalContributions: boolean;
  /**
   * Threshold for the "promote counterparty to Contact" suggestion (#373).
   * Surfaces a suggestion when un-linked counterparty_raw recurs >= N
   * times in the trailing 90 days. Default 3, bounded 2..50.
   */
  counterpartyPromotionThreshold: number;
};

export type SafeToSpendBreakdown = {
  currentCash: number;
  upcomingRequiredExpenses: number;
  requiredSavingsContributions: number;
  expectedCreditCardPayments: number;
  minimumBuffer: number;
};

/** Response shape for GET /api/forecast/safe-to-spend. */
export type SafeToSpendResponse = {
  currency: string;
  asOfDate: string;
  windowDays: number;
  windowEndDate: string;
  value: number;
  isNegative: boolean;
  breakdown: SafeToSpendBreakdown;
  settings: CashflowSettings;
};

// --- FX & currency intelligence (issue #221) -------------------------------

export type CurrencyExposureRow = {
  currency: string;
  transactionCount: number;
  sumNative: number;
  absSumNative: number;
  cadEquivalent: number | null;
  shareOfTotal: number;
  fxRate: number | null;
  ratedDate: string | null;
};

export type CurrencyExposureResponse = {
  reportingCurrency: string;
  asOf: string;
  totalCadEquivalent: number;
  byCurrency: CurrencyExposureRow[];
  gaps: Array<{ currency: string; reason: 'fx_rate_unavailable' }>;
};

export type FxFeeRow = {
  transactionId: number;
  accountId: number;
  accountName: string | null;
  date: string;
  merchant: string;
  currency: string;
  amount: number;
  reason: string;
  confidence: 'high' | 'medium' | 'low' | null;
};

export type FxFeesResponse = {
  fees: FxFeeRow[];
  total: number;
  limit: number;
};

export type EffectiveRateRow = {
  transactionId: number;
  accountId: number;
  date: string;
  merchant: string;
  fromCurrency: string;
  toCurrency: string;
  nativeAmount: number;
  effectiveRate: number;
  source: 'linked_transaction' | 'paired_transfer';
  counterpartyTransactionId: number;
};

export type EffectiveRatesResponse = {
  rates: EffectiveRateRow[];
  total: number;
  limit: number;
};

export type FxReportingMetric = {
  key: string;
  normalized: number;
  partial: boolean;
  contributions: Array<{
    currency: string;
    native: number;
    normalized: number | null;
    fxRate: number | null;
    ratedDate: string | null;
  }>;
};

export type FxReportingResponse = {
  reportingCurrency: string;
  asOf: string;
  metrics: FxReportingMetric[];
  fxRatesUsed: Array<{ from: string; to: string; rate: number; ratedDate: string }>;
  gaps: Array<{ currency: string; reason: 'fx_rate_unavailable' }>;
  transactionCountByCurrency: Record<string, number>;
};

// ---- Notifications (issue #266) -----------------------------------------

export type NotificationSeverity = 'info' | 'warn' | 'critical';

export type Notification = {
  id: number;
  type: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  dataJson: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
};

export type NotificationsListResponse = {
  data: Notification[];
};

export type NotificationUnreadCountResponse = {
  count: number;
};

export type NotificationPreference = {
  type: string;
  channelInApp: boolean;
  channelEmail: boolean;
};

export type NotificationPreferencesListResponse = {
  data: NotificationPreference[];
};

/** Local-first encrypted sync foundation (#239). */
export type SyncBackupResponse = {
  bundle: string;
  bundleVersion: number;
  schemaVersion: number;
  createdAt: string;
  origin: string;
  bundleBytes: number;
  rowCount: number;
  tableCounts: Record<string, number>;
};

export type SyncRestorePreviewResponse = {
  sourceHouseholdId: number | null;
  createdAt: string;
  origin: string;
  schemaVersion: number;
  bundleBytes: number;
  rowCount: number;
  tableCounts: Record<string, number>;
};

export type SyncRestoreMode = 'merge' | 'replace';

// ---- Data exports (issue #302) -------------------------------------------

export type DataExportStatus = 'queued' | 'running' | 'ready' | 'failed';

export type DataExport = {
  id: number;
  status: DataExportStatus;
  requestedAt: string;
  readyAt: string | null;
  expiresAt: string | null;
  byteSize: number | null;
  errorMessage: string | null;
  /** Backend-generated signed download URL; present only when status=ready */
  downloadUrl: string | null;
};

export type DataExportsListResponse = {
  data: DataExport[];
};

export type RequestDataExportResponse = {
  exportId: number;
  status: DataExportStatus;
};

export type RequestDataExportError = {
  error: 'EXPORT_IN_FLIGHT';
  message: string;
  exportId: number;
};

export type SyncRestoreResponse = {
  mode: SyncRestoreMode;
  inserted: Record<string, number>;
  skipped: Record<string, number>;
  sourceHouseholdId: number | null;
  createdAt: string;
};

export type SyncHistoryEntry = {
  id: number;
  kind: 'backup' | 'restore';
  bundleVersion: number;
  schemaVersion: number;
  bundleBytes: number;
  tableCounts: Record<string, number>;
  createdAt: string;
};

export type SyncHistoryResponse = {
  data: SyncHistoryEntry[];
};
