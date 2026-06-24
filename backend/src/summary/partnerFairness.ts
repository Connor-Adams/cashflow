/**
 * Pure aggregation helpers for the Partner Fairness dashboard (issue #207).
 *
 * Single-payer model recap (see partnerMath.ts for full rationale):
 *   - The uploader ("me") is the only payer on every imported transaction.
 *   - `partnerShareAmount` on each row is what the partner owes me back —
 *     it is the only "debt" component. `myShareAmount` is my own portion
 *     and is NOT a debt.
 *   - A "shared" transaction is one where the partner has a non-zero share,
 *     i.e. `partnerShareAmount !== 0`. Both true joint ('shared' split) and
 *     contact-tagged rows show up here. Sign matches `amount` sign
 *     (negative for purchases, positive for refunds).
 *
 * Settlement signs match `partnerMath.applySettlements`:
 *   - `i_paid_partner` REDUCES what I owe → +balance for "partner owes me"
 *   - `partner_paid_me` REDUCES what partner owes me → -balance
 *
 * All numeric values are JS numbers (sub-cent rounding handled at the
 * "direction" boundary so values like `0.001` don't get rendered as a
 * one-cent debt).
 */

/** Raw aggregated row keyed by (currency, month, category). */
export type SharedTxnRow = {
  /** YYYY-MM-DD */
  date: string;
  currency: string;
  /** May be null when the txn was never categorized — surfaces as "Uncategorized". */
  category: string | null;
  merchant: string;
  /** Signed transaction amount (negative for purchases). */
  amount: number;
  /** Signed: positive when I covered some of the cost (purchase). */
  myShare: number;
  /** Signed: positive when partner owes me, negative on refunds against shared items. */
  partnerShare: number;
  /** Transaction id — used for "largest shared transactions" deep-link. */
  txnId: number;
  ownershipType: string;
  ownershipContactId: number | null;
  contactName: string | null;
  /**
   * #375 — counterparty Contact id (from PR #380). Independent of
   * ownershipContactId: counterparty is "who paid in / who got paid",
   * ownership is "who the spend belongs to". NULL on legacy rows and on
   * any row where the import pipeline did not surface a counterparty.
   */
  counterpartyContactId: number | null;
  /** transactions.created_by_user_id — the payer in the single-payer model. Drives viewer-relative projection. NULL on legacy rows. */
  payerUserId: number | null;
  /**
   * Controller-set sharedness flag. `buildFairnessByCurrency`/`buildFairnessMonthly`
   * project rows for the viewer, which can drive the displayed `partnerShare` to 0
   * on a still-shared row (stored myShare=0 → non-payer view). The aggregation
   * helpers honour this flag so a shared row is never dropped on its projected
   * value. Direct callers that omit it fall back to `partnerShare !== 0`.
   */
  shared?: boolean;
};

/** Direct partner transfer amounts per currency (in = partner sent me, out = I sent partner). */
export type PartnerTransferTotals = { in: number; out: number };

/** Settlement summary keyed by (contactId, currency). Mirrors `partnerMath.SettlementSummary`. */
export type SettlementTotals = {
  contactId: number;
  currency: string;
  /** Sum of `i_paid_partner` rows in this scope. */
  iPaid: number;
  /** Sum of `partner_paid_me` rows in this scope. */
  partnerPaid: number;
};

/** One bucket of the category breakdown. */
export type FairnessCategoryBreakdown = {
  category: string;
  sharedSpend: number;
  myShare: number;
  partnerShare: number;
  transactionCount: number;
};

/** One of the largest shared transactions (top-N). */
export type FairnessLargestTransaction = {
  txnId: number;
  date: string;
  merchant: string;
  category: string | null;
  amount: number;
  myShare: number;
  partnerShare: number;
  ownershipType: string;
  ownershipContactId: number | null;
  contactName: string | null;
};

/** "Who paid more" — pure who-covered-shared-spend rollup per currency. */
export type FairnessPaidMore = {
  /** What I covered out-of-pocket (sum |myShare| for shared rows). */
  youCovered: number;
  /** What partner has covered via settlements (sum partnerPaid - iPaid, floored at 0). */
  partnerCovered: number;
};

/**
 * Per-currency fairness summary, suitable for direct JSON return.
 * `balance` follows the sign convention from partnerMath:
 *    > 0 → partner owes me, < 0 → I owe partner, == 0 → even (after sub-cent round).
 */
export type FairnessByCurrency = {
  currency: string;
  /**
   * Sum of `partnerShare` across every shared row in the scope. This is the
   * gross "what partner owes me" before settlements.
   */
  sharedSpendTotal: number;
  /** Sum of `myShare` across every shared row. My out-of-pocket portion of shared spend. */
  myShareTotal: number;
  /** Sum of `partnerShare` across every shared row. Same as sharedSpendTotal but named for symmetry. */
  partnerShareTotal: number;
  /** Number of distinct shared transactions. */
  sharedTransactionCount: number;
  /**
   * Current-month shared spend (purchases only, sign flipped to positive for
   * display: sum of |amount| where partnerShare !== 0 and amount < 0).
   * Refunds reduce this; we floor at 0 so a refund-heavy month never goes
   * negative in the headline metric.
   */
  currentMonthSharedSpend: number;
  /**
   * #375 — sum of positive-amount rows whose counterparty_contact_id is a
   * partner Contact (Contact.is_partner=true). Always reported regardless of
   * the excludeNonPartnerInflows toggle so the UI can show both totals
   * side-by-side.
   */
  partnerInflows: number;
  /**
   * #375 — sum of positive-amount rows whose counterparty is NOT a partner
   * Contact (NULL or a non-partner Contact). These are the friend-paid-back-
   * lunch / side-gig / family-gift rows the toggle defaults to excluding.
   */
  nonPartnerInflows: number;
  /** Direct partner transfers folded into balance (in = partner sent me, out = I sent partner). */
  partnerTransfers: PartnerTransferTotals;
  /**
   * Cumulative settlement-adjusted balance: sum of per-row viewer-relative
   * balance contributions + (iPaid − partnerPaid). Each shared row contributes
   * `payer==viewer ? −partnerShare : +partnerShare` (see `projectRow`). In the
   * owner / no-viewer POV this collapses to `−partnerShareTotal + (iPaid −
   * partnerPaid)` — the original single-payer formula. Spend is stored negative,
   * so the payer's `−partnerShare` yields the positive "owed to me" value.
   * Positive: partner owes me (this viewer). Negative: I owe partner.
   */
  balance: number;
  /** Direction is computed at sub-cent precision so 0.001 renders as "even". */
  direction: 'partner_owes_me' | 'i_owe_partner' | 'even';
  /** "Who paid more" rollup. */
  paidMore: FairnessPaidMore;
  /** Top categories by absolute shared spend. */
  categoryBreakdown: FairnessCategoryBreakdown[];
  /** Top-N largest shared transactions by |amount|. */
  largestShared: FairnessLargestTransaction[];
};

/** One point of the historical fairness trend. */
export type FairnessMonthlyPoint = {
  /** YYYY-MM */
  month: string;
  currency: string;
  /** Signed sum of shared-row amount (purchases negative, refunds positive). */
  sharedSpend: number;
  myShare: number;
  partnerShare: number;
  /** Total settlement movement in this month (iPaid - partnerPaid). */
  settlementDelta: number;
  /**
   * Net change to outstanding balance in this month: sum of per-row viewer-relative
   * balance contributions + settlementDelta (see `projectRow`). In the owner /
   * no-viewer POV this equals `−partnerShare + settlementDelta`. Spend is stored
   * negative; the payer's contribution yields the "owed to me" delta for the month.
   */
  netDelta: number;
  /** Running cumulative balance through the END of this month. */
  cumulativeBalance: number;
};

/** Settlement recommendation per currency. */
export type SettlementRecommendation = {
  currency: string;
  /** Absolute amount, formatted with 2 decimal places at the JSON boundary. */
  amount: number;
  /** Who should pay whom to bring the balance to zero. `none` when balance is sub-cent even. */
  direction: 'partner_pays_you' | 'you_pay_partner' | 'none';
  /** The raw signed balance the recommendation is settling. Useful for tooltips. */
  outstandingBalance: number;
};

/** The lone is_partner contact id, or null when the household has ≠ 1 partner. */
export function resolveSolePartnerId(partnerContactIds: Set<number>): number | null {
  return partnerContactIds.size === 1 ? [...partnerContactIds][0] : null;
}

/**
 * Which contact a split expense (partnerShare !== 0) belongs to. A split the
 * user explicitly assigned to a contact (ownershipType='contact') keeps that
 * contact; an unlabeled split falls to the single household partner. Returns
 * null → "Unassigned" bucket (no sole partner to attribute to).
 */
export function contactForSharedRow(
  row: SharedTxnRow,
  solePartnerId: number | null,
): number | null {
  if (row.ownershipType === 'contact' && row.ownershipContactId != null) {
    return row.ownershipContactId;
  }
  return solePartnerId;
}

const TOP_CATEGORY_LIMIT = 8;
const TOP_LARGEST_LIMIT = 10;

function directionFromBalance(
  balance: number,
): 'partner_owes_me' | 'i_owe_partner' | 'even' {
  const rounded = Math.round(balance * 100) / 100;
  if (rounded > 0) return 'partner_owes_me';
  if (rounded < 0) return 'i_owe_partner';
  return 'even';
}

/**
 * Slice rows to those whose date falls within `currentMonthStart` (inclusive)
 * and `nextMonthStart` (exclusive). `currentMonthStart` is a YYYY-MM-DD with
 * day=01.
 */
function isInCurrentMonth(
  date: string,
  currentMonthStart: string,
  nextMonthStart: string,
): boolean {
  return date >= currentMonthStart && date < nextMonthStart;
}

/**
 * Group rows by category and sort descending by absolute sharedSpend.
 * "Uncategorized" is a sentinel label used for null categories so the UI
 * never renders an empty cell. Top-N limit (8) keeps the chart legible.
 */
export function aggregateCategoryBreakdown(
  rows: SharedTxnRow[],
): FairnessCategoryBreakdown[] {
  const byCategory = new Map<string, FairnessCategoryBreakdown>();
  for (const r of rows) {
    if (!(r.shared ?? r.partnerShare !== 0)) continue;
    const key = r.category ?? 'Uncategorized';
    const bucket =
      byCategory.get(key) ??
      ({
        category: key,
        sharedSpend: 0,
        myShare: 0,
        partnerShare: 0,
        transactionCount: 0,
      } satisfies FairnessCategoryBreakdown);
    bucket.sharedSpend += r.amount;
    bucket.myShare += r.myShare;
    bucket.partnerShare += r.partnerShare;
    bucket.transactionCount += 1;
    byCategory.set(key, bucket);
  }
  return Array.from(byCategory.values())
    .sort((a, b) => Math.abs(b.sharedSpend) - Math.abs(a.sharedSpend))
    .slice(0, TOP_CATEGORY_LIMIT);
}

/**
 * Top-N largest shared transactions by absolute amount.
 *
 * Refunds (positive amounts) are included intentionally: a $200 refund on a
 * shared purchase is just as informative as a $200 purchase when figuring
 * out who paid for what.
 */
export function topLargestShared(
  rows: SharedTxnRow[],
): FairnessLargestTransaction[] {
  return rows
    .filter((r) => r.shared ?? r.partnerShare !== 0)
    .slice()
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .slice(0, TOP_LARGEST_LIMIT)
    .map((r) => ({
      txnId: r.txnId,
      date: r.date,
      merchant: r.merchant,
      category: r.category,
      amount: r.amount,
      myShare: r.myShare,
      partnerShare: r.partnerShare,
      ownershipType: r.ownershipType,
      ownershipContactId: r.ownershipContactId,
      contactName: r.contactName,
    }));
}

/**
 * #375 — option bag for the fairness rollup. Pure value object so the
 * helper stays trivially testable.
 *
 * `partnerContactIds` lists the Contact ids the household has flagged as
 * `is_partner=true`. A row counts as a "partner inflow" when:
 *   1. `amount > 0` (positive-amount row — inflow), and
 *   2. `counterpartyContactId` is non-null and present in this set.
 * Everything else with `amount > 0` is a non-partner inflow.
 *
 * `excludeNonPartnerInflows` (default false here; the route caller threads
 * the user's CashflowSettings value through) drops non-partner-inflow rows
 * from the rollup BEFORE all totals are computed, so sharedSpendTotal,
 * partnerShareTotal, balance, and settlement recommendation all reflect
 * the cleaned set. The drop happens at the per-currency loop level so the
 * sharedTransactionCount also reflects what the user sees.
 */
export type FairnessOptions = {
  partnerContactIds?: Set<number>;
  excludeNonPartnerInflows?: boolean;
  /**
   * When set, project shares relative to this user: a row's consumption
   * display swaps when viewerUserId !== payerUserId, and balance uses the
   * per-row contribution `(payer==viewer ? -partnerShare : +partnerShare)`.
   * When null/undefined, behaves as owner POV (legacy: me = payer).
   */
  viewerUserId?: number | null;
  partnerTransfersByCurrency?: Map<string, PartnerTransferTotals>;
};

/**
 * Project a stored (owner-POV) row to the viewer's perspective.
 * - `shared` is computed from the STORED partnerShare (viewer-independent):
 *   a row is shared iff the non-payer owes a non-zero amount.
 * - `myShare`/`partnerShare` are consumption portions, swapped when the
 *   viewer is not the payer.
 * - `balanceContribution` is the signed receivable for the viewer:
 *   the payer is owed `partnerShare`; the non-payer owes it. Spend is stored
 *   negative, so `-partnerShare` yields the positive "owed to me" figure.
 */
function projectRow(
  row: SharedTxnRow,
  viewerUserId: number | null | undefined,
): { shared: boolean; myShare: number; partnerShare: number; balanceContribution: number } {
  const shared = row.partnerShare !== 0;
  const isPayer =
    viewerUserId == null || row.payerUserId == null || row.payerUserId === viewerUserId;
  return {
    shared,
    myShare: isPayer ? row.myShare : row.partnerShare,
    partnerShare: isPayer ? row.partnerShare : row.myShare,
    balanceContribution: isPayer ? -row.partnerShare : row.partnerShare,
  };
}

/**
 * #375 — classify a single shared row as a partner inflow or non-partner
 * inflow. Returns 'none' for non-inflow rows (amount <= 0) so the caller
 * can iterate once and compute both side counts.
 */
function classifyInflow(
  row: SharedTxnRow,
  partnerContactIds: Set<number>,
): 'partner' | 'non_partner' | 'none' {
  if (row.amount <= 0) return 'none';
  if (
    row.counterpartyContactId != null &&
    partnerContactIds.has(row.counterpartyContactId)
  ) {
    return 'partner';
  }
  return 'non_partner';
}

/**
 * Project one settlement row's direction to the viewer's perspective. A
 * settlement's `direction` is recorded relative to `recordedByUserId` ("i" =
 * that user). When the viewer is a DIFFERENT user, "i_paid_partner" reads as
 * "partner_paid_me" and vice-versa — so iPaid/partnerPaid swap. When viewer or
 * recordedBy is unknown (legacy / no auth), no flip (owner POV).
 */
export function projectSettlementContribution(
  direction: 'i_paid_partner' | 'partner_paid_me',
  amount: number,
  recordedByUserId: number | null,
  viewerUserId: number | null | undefined,
): { iPaid: number; partnerPaid: number } {
  const flip =
    viewerUserId != null && recordedByUserId != null && recordedByUserId !== viewerUserId;
  const iPaidRaw = direction === 'i_paid_partner' ? amount : 0;
  const partnerPaidRaw = direction === 'partner_paid_me' ? amount : 0;
  return flip
    ? { iPaid: partnerPaidRaw, partnerPaid: iPaidRaw }
    : { iPaid: iPaidRaw, partnerPaid: partnerPaidRaw };
}

/**
 * Per-currency direct partner transfers: money the partner sent me (`in`,
 * amount>0) vs money I sent the partner (`out`, amount<0), over rows where the
 * counterparty is a partner Contact AND partnerShare === 0 (pure transfers;
 * shared-split rows stay in the fairness path to avoid double-counting). Non-loan
 * categories are intentionally NOT excluded — cash between partners is real
 * settlement money.
 */
export function computePartnerTransferDelta(
  rows: SharedTxnRow[],
  partnerContactIds: Set<number>,
): Map<string, PartnerTransferTotals> {
  const out = new Map<string, PartnerTransferTotals>();
  for (const r of rows) {
    const cid = r.counterpartyContactId;
    if (cid == null || !partnerContactIds.has(cid)) continue;
    if (r.partnerShare !== 0) continue;
    const n = r.amount;
    if (!Number.isFinite(n) || n === 0) continue;
    const acc = out.get(r.currency) ?? { in: 0, out: 0 };
    if (n < 0) acc.out += -n;
    else acc.in += n;
    out.set(r.currency, acc);
  }
  return out;
}

/**
 * Build the per-currency fairness summary used by `GET /api/partner/fairness`.
 *
 * @param rows           Raw shared transaction rows (already scoped to household + date filter)
 * @param settlements    Pre-aggregated settlement totals scoped to the same date filter
 * @param currentMonthStart YYYY-MM-DD of the first day of the current month (caller passes today's month, or any reference month)
 * @param nextMonthStart YYYY-MM-DD of the first day of the month AFTER currentMonthStart
 * @param options         #375 — partner-contact set + excludeNonPartnerInflows toggle
 */
export function buildFairnessByCurrency(
  rows: SharedTxnRow[],
  settlements: SettlementTotals[],
  currentMonthStart: string,
  nextMonthStart: string,
  options: FairnessOptions = {},
): FairnessByCurrency[] {
  const partnerContactIds = options.partnerContactIds ?? new Set<number>();
  const excludeNonPartnerInflows = options.excludeNonPartnerInflows ?? false;
  const viewerUserId = options.viewerUserId;
  const partnerTransfers = options.partnerTransfersByCurrency ?? new Map<string, PartnerTransferTotals>();

  const byCurrency = new Map<string, FairnessByCurrency>();

  // Bucket shared rows per currency. #375 — when excludeNonPartnerInflows is
  // on, drop non-partner inflows BEFORE bucketing so every downstream total
  // (sharedSpendTotal, balance, categoryBreakdown, largestShared) ignores
  // them. We still tally the inflow splits separately on the unfiltered
  // input below, so the user can always see what they're hiding.
  //
  // Rows are pushed PROJECTED to the viewer (myShare/partnerShare swapped when
  // the viewer is not the payer) so all downstream display reads the viewer's
  // values. Sharedness uses the STORED partnerShare (viewer-independent), and
  // the per-row balance contribution is accumulated separately — balance is
  // NOT derivable from the swapped totals.
  const rowsByCurrency = new Map<string, SharedTxnRow[]>();
  const contributionsByCurrency = new Map<string, number>();
  for (const r of rows) {
    const p = projectRow(r, viewerUserId);
    if (!p.shared) continue;
    if (excludeNonPartnerInflows) {
      const kind = classifyInflow(r, partnerContactIds);
      if (kind === 'non_partner') continue;
    }
    const list = rowsByCurrency.get(r.currency) ?? [];
    list.push({ ...r, myShare: p.myShare, partnerShare: p.partnerShare, shared: p.shared });
    rowsByCurrency.set(r.currency, list);
    contributionsByCurrency.set(
      r.currency,
      (contributionsByCurrency.get(r.currency) ?? 0) + p.balanceContribution,
    );
  }

  // Tally partner/non-partner inflows on the unfiltered input so the UI can
  // present both totals even when the toggle is hiding the non-partner side.
  const inflowsByCurrency = new Map<string, { partner: number; nonPartner: number }>();
  for (const r of rows) {
    if (r.partnerShare === 0) continue;
    const kind = classifyInflow(r, partnerContactIds);
    if (kind === 'none') continue;
    const acc = inflowsByCurrency.get(r.currency) ?? { partner: 0, nonPartner: 0 };
    if (kind === 'partner') acc.partner += r.amount;
    else acc.nonPartner += r.amount;
    inflowsByCurrency.set(r.currency, acc);
  }

  // Bucket settlements per currency (sum across contacts).
  const settlementByCurrency = new Map<string, { iPaid: number; partnerPaid: number }>();
  for (const s of settlements) {
    const cur = settlementByCurrency.get(s.currency) ?? { iPaid: 0, partnerPaid: 0 };
    cur.iPaid += s.iPaid;
    cur.partnerPaid += s.partnerPaid;
    settlementByCurrency.set(s.currency, cur);
  }

  // Union currencies across rows, inflows, settlements, and transfers so a
  // currency with only one of those still surfaces.
  const allCurrencies = new Set<string>([
    ...rowsByCurrency.keys(),
    ...inflowsByCurrency.keys(),
    ...settlementByCurrency.keys(),
    ...partnerTransfers.keys(),
  ]);

  for (const currency of allCurrencies) {
    const list = rowsByCurrency.get(currency) ?? [];
    const settlement = settlementByCurrency.get(currency) ?? { iPaid: 0, partnerPaid: 0 };
    const inflowSplit = inflowsByCurrency.get(currency) ?? { partner: 0, nonPartner: 0 };
    const tr = partnerTransfers.get(currency) ?? { in: 0, out: 0 };
    let sharedSpendTotal = 0;
    let myShareTotal = 0;
    let partnerShareTotal = 0;
    let currentMonthSharedSpend = 0;
    for (const r of list) {
      sharedSpendTotal += r.amount;
      myShareTotal += r.myShare;
      partnerShareTotal += r.partnerShare;
      // Headline "current month spend" is a positive-display purchase count:
      // sum |amount| for purchase rows (amount < 0) in this month.
      if (
        r.amount < 0 &&
        isInCurrentMonth(r.date, currentMonthStart, nextMonthStart)
      ) {
        currentMonthSharedSpend += Math.abs(r.amount);
      }
    }
    // Viewer-relative shared-row contribution (= −partnerShareTotal in owner POV)
    // + settlements + main's direct partner-transfer delta.
    const rowsContribution = contributionsByCurrency.get(currency) ?? 0;
    const balance =
      rowsContribution + (settlement.iPaid - settlement.partnerPaid) + (tr.out - tr.in);
    const paidMore: FairnessPaidMore = {
      // What I covered = my-share on shared rows (purchases). Positive number for display.
      youCovered: Math.max(0, -myShareTotal),
      // Partner covered via settlements (net partnerPaid in - iPaid out).
      partnerCovered: Math.max(0, settlement.partnerPaid - settlement.iPaid),
    };
    byCurrency.set(currency, {
      currency,
      sharedSpendTotal,
      myShareTotal,
      partnerShareTotal,
      sharedTransactionCount: list.length,
      currentMonthSharedSpend,
      partnerInflows: inflowSplit.partner,
      nonPartnerInflows: inflowSplit.nonPartner,
      partnerTransfers: tr,
      balance,
      direction: directionFromBalance(balance),
      paidMore,
      categoryBreakdown: aggregateCategoryBreakdown(list),
      largestShared: topLargestShared(list),
    });
  }

  return Array.from(byCurrency.values()).sort((a, b) =>
    a.currency.localeCompare(b.currency),
  );
}

/**
 * Build the historical fairness trend.
 *
 * Months without any activity (no shared txn + no settlement) are omitted —
 * the chart treats absent months as zero-delta and connects the dots
 * visually. The `cumulativeBalance` is a running total from the EARLIEST
 * month in the dataset through each emitted month; callers passing a
 * narrowed date range still get a balance relative to that range, NOT the
 * lifetime balance. Pass an unfiltered range for the lifetime view.
 *
 * #375 — when `options.excludeNonPartnerInflows` is true, non-partner
 * inflow rows are dropped before bucketing so the monthly netDelta and
 * cumulativeBalance reflect the same cleaned set as the headline fairness.
 */
export function buildFairnessMonthly(
  rows: SharedTxnRow[],
  settlements: Array<SettlementTotals & { /** YYYY-MM */ month: string }>,
  options: FairnessOptions = {},
): FairnessMonthlyPoint[] {
  const partnerContactIds = options.partnerContactIds ?? new Set<number>();
  const excludeNonPartnerInflows = options.excludeNonPartnerInflows ?? false;
  const viewerUserId = options.viewerUserId;

  type Acc = {
    sharedSpend: number;
    myShare: number;
    partnerShare: number;
    settlementDelta: number;
    /** Sum of per-row viewer-relative balance contributions (netDelta base). */
    contribution: number;
  };
  const byKey = new Map<string, Acc>(); // key: `${currency}\0${month}`

  for (const r of rows) {
    const p = projectRow(r, viewerUserId);
    if (!p.shared) continue;
    if (excludeNonPartnerInflows) {
      const kind = classifyInflow(r, partnerContactIds);
      if (kind === 'non_partner') continue;
    }
    const month = r.date.slice(0, 7); // YYYY-MM
    const key = `${r.currency}\0${month}`;
    const acc =
      byKey.get(key) ??
      ({ sharedSpend: 0, myShare: 0, partnerShare: 0, settlementDelta: 0, contribution: 0 } satisfies Acc);
    acc.sharedSpend += r.amount;
    acc.myShare += p.myShare;
    acc.partnerShare += p.partnerShare;
    acc.contribution += p.balanceContribution;
    byKey.set(key, acc);
  }

  for (const s of settlements) {
    const key = `${s.currency}\0${s.month}`;
    const acc =
      byKey.get(key) ??
      ({ sharedSpend: 0, myShare: 0, partnerShare: 0, settlementDelta: 0, contribution: 0 } satisfies Acc);
    acc.settlementDelta += s.iPaid - s.partnerPaid;
    byKey.set(key, acc);
  }

  // Partner direct transfers behave like settlements (same (out − in) fold as
  // the headline balance): one `+= -n` handles both directions.
  for (const r of rows) {
    const cid = r.counterpartyContactId;
    if (cid == null || !partnerContactIds.has(cid)) continue;
    if (r.partnerShare !== 0) continue;
    const n = r.amount;
    if (!Number.isFinite(n) || n === 0) continue;
    const month = r.date.slice(0, 7);
    const key = `${r.currency}\0${month}`;
    const acc =
      byKey.get(key) ??
      ({ sharedSpend: 0, myShare: 0, partnerShare: 0, settlementDelta: 0, contribution: 0 } satisfies Acc);
    acc.settlementDelta += -n;
    byKey.set(key, acc);
  }

  // Sort by (currency, month) so running cumulative is computed in order.
  const entries: Array<{ currency: string; month: string; acc: Acc }> = [];
  for (const [k, acc] of byKey.entries()) {
    const [currency, month] = k.split('\0');
    entries.push({ currency, month, acc });
  }
  entries.sort((a, b) =>
    a.currency === b.currency
      ? a.month.localeCompare(b.month)
      : a.currency.localeCompare(b.currency),
  );

  const runningByCurrency = new Map<string, number>();
  const points: FairnessMonthlyPoint[] = [];
  for (const { currency, month, acc } of entries) {
    const netDelta = acc.contribution + acc.settlementDelta;
    const running = (runningByCurrency.get(currency) ?? 0) + netDelta;
    runningByCurrency.set(currency, running);
    points.push({
      month,
      currency,
      sharedSpend: acc.sharedSpend,
      myShare: acc.myShare,
      partnerShare: acc.partnerShare,
      settlementDelta: acc.settlementDelta,
      netDelta,
      cumulativeBalance: running,
    });
  }
  return points;
}

export type PaybackEntry = {
  source: 'transfer' | 'settlement';
  date: string;
  /** Absolute amount of the movement. */
  amount: number;
  currency: string;
  direction: 'partner_paid_me' | 'i_paid_partner';
  note: string | null;
  /** Transaction id for transfer-sourced rows; null for manual settlements. */
  txnId: number | null;
};

export type RawSettlementForPayback = {
  contactId: number;
  currency: string;
  direction: 'i_paid_partner' | 'partner_paid_me';
  amount: number;
  settledDate: string;
  note: string | null;
};

/** Pure partner-to-partner transfers bucketed by counterparty contact, then currency. */
export function computeTransfersByContact(
  rows: SharedTxnRow[],
): Map<number, Map<string, PartnerTransferTotals>> {
  const out = new Map<number, Map<string, PartnerTransferTotals>>();
  for (const r of rows) {
    const cid = r.counterpartyContactId;
    if (cid == null) continue;
    if (r.partnerShare !== 0) continue;
    const n = r.amount;
    if (!Number.isFinite(n) || n === 0) continue;
    const byCur = out.get(cid) ?? new Map<string, PartnerTransferTotals>();
    const acc = byCur.get(r.currency) ?? { in: 0, out: 0 };
    if (n < 0) acc.out += -n;
    else acc.in += n;
    byCur.set(r.currency, acc);
    out.set(cid, byCur);
  }
  return out;
}

/**
 * Display list of paybacks for one contact: tagged transfers (from the txn
 * rows) + manual settlement records. Display-only — the balance already counts
 * both via the transfer delta and settlement delta, so this never feeds the
 * math. Sorted newest first.
 */
export function buildPaybacks(
  contactRows: SharedTxnRow[],
  contactSettlements: RawSettlementForPayback[],
): PaybackEntry[] {
  const out: PaybackEntry[] = [];
  for (const r of contactRows) {
    if (r.counterpartyContactId == null) continue;
    if (r.partnerShare !== 0) continue;
    if (!Number.isFinite(r.amount) || r.amount === 0) continue;
    out.push({
      source: 'transfer',
      date: r.date,
      amount: Math.abs(r.amount),
      currency: r.currency,
      direction: r.amount > 0 ? 'partner_paid_me' : 'i_paid_partner',
      note: r.merchant,
      txnId: r.txnId,
    });
  }
  for (const s of contactSettlements) {
    out.push({
      source: 'settlement',
      date: s.settledDate,
      amount: Math.abs(s.amount),
      currency: s.currency,
      direction: s.direction,
      note: s.note,
      txnId: null,
    });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

export type FairnessContact = {
  contactId: number | null;
  contactName: string;
  isPartner: boolean;
  byCurrency: FairnessByCurrency[];
  paybacks: PaybackEntry[];
};

/**
 * Partition every contributing row/settlement/transfer by contact, then run the
 * existing per-currency builder on each contact's subset. A row contributes to a
 * contact when it is that contact's split (contactForSharedRow) OR a transfer
 * whose counterparty is that contact. Pure-`me` rows (partnerShare 0, no
 * counterparty) contribute to nobody and are dropped.
 */
export function buildFairnessByContact(
  rows: SharedTxnRow[],
  settlementTotals: SettlementTotals[],
  rawSettlements: RawSettlementForPayback[],
  currentMonthStart: string,
  nextMonthStart: string,
  options: FairnessOptions = {},
  contactsMeta: Map<number, { name: string; isPartner: boolean }> = new Map(),
): FairnessContact[] {
  const partnerContactIds = options.partnerContactIds ?? new Set<number>();
  const solePartnerId = resolveSolePartnerId(partnerContactIds);
  const transfersByContact = computeTransfersByContact(rows);

  // contactId (number | null) → rows. null = Unassigned bucket.
  const rowsByContact = new Map<number | null, SharedTxnRow[]>();
  const add = (cid: number | null, r: SharedTxnRow) => {
    const list = rowsByContact.get(cid) ?? [];
    list.push(r);
    rowsByContact.set(cid, list);
  };
  for (const r of rows) {
    if (r.partnerShare !== 0) {
      add(contactForSharedRow(r, solePartnerId), r);
    } else if (r.counterpartyContactId != null) {
      add(r.counterpartyContactId, r);
    }
  }

  // Ensure contacts that appear only via settlements still surface.
  const allContactIds = new Set<number | null>(rowsByContact.keys());
  for (const s of settlementTotals) allContactIds.add(s.contactId);

  const result: FairnessContact[] = [];
  for (const cid of allContactIds) {
    const contactRows = rowsByContact.get(cid) ?? [];
    const contactSettleTotals =
      cid == null ? [] : settlementTotals.filter((s) => s.contactId === cid);
    const contactRawSettlements =
      cid == null ? [] : rawSettlements.filter((s) => s.contactId === cid);
    const partnerTransfersByCurrency =
      cid == null ? new Map() : transfersByContact.get(cid) ?? new Map();

    const byCurrency = buildFairnessByCurrency(
      contactRows,
      contactSettleTotals,
      currentMonthStart,
      nextMonthStart,
      { ...options, partnerTransfersByCurrency },
    );
    if (byCurrency.length === 0) continue;

    const meta = cid != null ? contactsMeta.get(cid) : undefined;
    result.push({
      contactId: cid,
      contactName: meta?.name ?? (cid == null ? 'Unassigned' : `Contact ${cid}`),
      isPartner: meta?.isPartner ?? false,
      byCurrency,
      paybacks: buildPaybacks(contactRows, contactRawSettlements),
    });
  }

  // Partners first, then by name.
  return result.sort((a, b) =>
    a.isPartner === b.isPartner
      ? a.contactName.localeCompare(b.contactName)
      : a.isPartner ? -1 : 1,
  );
}

/**
 * Per-contact wrapper over `buildFairnessMonthly`. Partitions rows by contact
 * using the same `contactForSharedRow`/`resolveSolePartnerId` logic as
 * `buildFairnessByContact`, then runs the existing monthly builder on each
 * contact's subset. Partners sort first, then alphabetically.
 */
export function buildFairnessMonthlyByContact(
  rows: SharedTxnRow[],
  monthlySettlements: Array<SettlementTotals & { month: string }>,
  options: FairnessOptions = {},
  contactsMeta: Map<number, { name: string; isPartner: boolean }> = new Map(),
): Array<{ contactId: number | null; contactName: string; isPartner: boolean; points: FairnessMonthlyPoint[] }> {
  const solePartnerId = resolveSolePartnerId(options.partnerContactIds ?? new Set<number>());

  const rowsByContact = new Map<number | null, SharedTxnRow[]>();
  const add = (cid: number | null, r: SharedTxnRow) => {
    const list = rowsByContact.get(cid) ?? [];
    list.push(r);
    rowsByContact.set(cid, list);
  };
  for (const r of rows) {
    if (r.partnerShare !== 0) add(contactForSharedRow(r, solePartnerId), r);
    else if (r.counterpartyContactId != null) add(r.counterpartyContactId, r);
  }
  const allContactIds = new Set<number | null>(rowsByContact.keys());
  for (const s of monthlySettlements) allContactIds.add(s.contactId);

  const out: Array<{ contactId: number | null; contactName: string; isPartner: boolean; points: FairnessMonthlyPoint[] }> = [];
  for (const cid of allContactIds) {
    const contactRows = rowsByContact.get(cid) ?? [];
    const contactSettlements =
      cid == null ? [] : monthlySettlements.filter((s) => s.contactId === cid);
    const points = buildFairnessMonthly(contactRows, contactSettlements, options);
    if (points.length === 0) continue;
    const meta = cid != null ? contactsMeta.get(cid) : undefined;
    out.push({
      contactId: cid,
      contactName: meta?.name ?? (cid == null ? 'Unassigned' : `Contact ${cid}`),
      isPartner: meta?.isPartner ?? false,
      points,
    });
  }
  return out.sort((a, b) =>
    a.isPartner === b.isPartner ? a.contactName.localeCompare(b.contactName) : a.isPartner ? -1 : 1,
  );
}

/**
 * Per-contact wrapper over `buildSettlementRecommendation`. Maps each
 * `FairnessContact`'s `byCurrency` array through the existing recommendation
 * builder and tags the output with the contact's id and name.
 */
export function buildSettlementRecommendationByContact(
  contacts: FairnessContact[],
): Array<{ contactId: number | null; contactName: string; recommendations: SettlementRecommendation[] }> {
  return contacts.map((c) => ({
    contactId: c.contactId,
    contactName: c.contactName,
    recommendations: buildSettlementRecommendation(c.byCurrency),
  }));
}

/**
 * Derive a settlement recommendation from the per-currency outstanding
 * balance. Sub-cent balances collapse to `direction: 'none'` so the UI
 * doesn't suggest paying a fraction of a cent.
 */
export function buildSettlementRecommendation(
  fairness: FairnessByCurrency[],
): SettlementRecommendation[] {
  return fairness.map((f) => {
    const rounded = Math.round(f.balance * 100) / 100;
    const amount = Math.abs(rounded);
    let direction: SettlementRecommendation['direction'];
    if (rounded > 0) direction = 'partner_pays_you';
    else if (rounded < 0) direction = 'you_pay_partner';
    else direction = 'none';
    return {
      currency: f.currency,
      amount,
      direction,
      outstandingBalance: f.balance,
    };
  });
}
