/**
 * Cashflow Sankey aggregator (issue #224).
 *
 * Pure function: given a pre-filtered set of transaction rows (the route
 * applies visibility + currency + date where-clauses upstream), returns
 * the {nodes, links} shape consumed by recharts' Sankey component, plus
 * an `edgeMap` so the route can resolve a clicked flow segment back into
 * the underlying transaction IDs.
 *
 * Flow model
 * ----------
 * The Sankey draws three layers left-to-right:
 *
 *   SOURCES (income / inflows)
 *     ── "Income"          income txnType + positive credits that net
 *                          inflows (refund/reward) routed back to source.
 *                          See classifyPositiveAmount('credit') in
 *                          classifyTransactionFlow.ts.
 *
 *   MIDDLE (categories — top-N + Uncategorized)
 *     ── one node per finalCategory bucket, plus an "Uncategorized" node
 *        for null/empty categories. Spend < 0 + non-spend filter applies.
 *
 *   SINKS (terminal pools)
 *     ── "Business spending" — finalBusiness=true spend
 *     ── "Savings & investments" — derived from positive 'income' on
 *        investment accounts… no, see below.
 *
 * For the v1 in this PR we use the simpler two-layer model that recharts
 * Sankey renders cleanly: SOURCES → categories. Each category node is
 * both a middle and a sink. This matches how the existing dashboard
 * thinks about money (by category) and reconciles directly with
 * aggregateDashboard.byCategory.
 *
 * Internal-transfer handling
 * --------------------------
 * Transfers, investment purchases, and dividend reinvestments are
 * money-movement, not spending. `isNonCategorical` (the same gate used
 * by aggregateDashboard) drops them BEFORE bucketing — so the Sankey's
 * totalIncome and totalSpend reconcile against the dashboard headlines
 * for the same filter.
 *
 * The aggregator also exposes an `edgeMap` keyed by `"{sourceIdx}-{targetIdx}"`
 * so the drill-down endpoint can return the transaction IDs that flowed
 * through a clicked link without re-running the aggregation.
 */
import { num } from '../util/numbers';
import {
  classifyPositiveAmount,
  isNonCategorical,
  isNonSpend,
} from './classifyTransactionFlow';

export type SankeyTxnRow = {
  id: number;
  date: string;
  currency: string;
  finalCategory: string | null;
  finalBusiness: boolean;
  merchantRaw: string | null;
  merchantClean: string | null;
  amount: unknown;
  txnType: string | null;
  /** Account type — used to gate non-spend classification (investment). */
  accountType: string | null;
};

export type SankeyNodeKind =
  | 'income'
  | 'category'
  | 'business'
  | 'savings'
  | 'uncategorized';

export interface SankeyNode {
  /** Display name (also acts as the unique key inside the response). */
  name: string;
  kind: SankeyNodeKind;
}

export interface SankeyLink {
  /** Index into the nodes array. */
  source: number;
  /** Index into the nodes array. */
  target: number;
  /** Always positive — represents dollars (or units of the active currency). */
  value: number;
}

export interface SankeyResult {
  currency: string;
  /** Sum of all SOURCE outflows (positive). 0 when no income observed. */
  totalIncome: number;
  /** Sum of all SINK inflows (positive). Equals sum of spend + business spend. */
  totalSpend: number;
  /** Aggregate count of transaction rows that contributed to any link. */
  transactionCount: number;
  nodes: SankeyNode[];
  links: SankeyLink[];
  /**
   * Map of `"sourceIdx-targetIdx"` → ordered list of transaction IDs that
   * contributed to that link. Used by the drill-down endpoint so the
   * client can resolve a clicked segment back to source rows without
   * re-running aggregation.
   */
  edgeMap: Map<string, number[]>;
}

/**
 * The category-layer node count is capped so the Sankey stays readable.
 * Categories beyond the cap (ranked by total spend descending) fold into
 * a single "Other categories" node so totals still reconcile.
 */
export const DEFAULT_TOP_CATEGORIES = 12;

const UNCATEGORIZED_LABEL = 'Uncategorized';
const OTHER_CATEGORIES_LABEL = 'Other categories';
const INCOME_LABEL = 'Income';

/**
 * Resolves the category label for a single row. Trimmed finalCategory wins;
 * empty/null falls back to UNCATEGORIZED_LABEL. This is the same precedence
 * used by aggregateDashboard so totals reconcile per category.
 */
export function resolveCategoryLabel(row: {
  finalCategory: string | null;
}): string {
  const c = (row.finalCategory ?? '').trim();
  return c.length > 0 ? c : UNCATEGORIZED_LABEL;
}

interface AggregateOptions {
  /** Cap on category nodes; surplus collapses into "Other categories". */
  topCategories?: number;
}

/**
 * Build the Sankey shape for a single currency.
 *
 * Filtering happens in TWO passes:
 *   1. Drop non-categorical money movement (transfers/investments/dividends)
 *      — these are not income or spend. Matches dashboard's filter.
 *   2. Drop rows whose `amount` doesn't parse.
 *
 * Then rows are bucketed:
 *   - Negative + !isNonSpend → spend → category sink, OR business sink if
 *     finalBusiness=true (overrides category routing).
 *   - Positive + classifyPositiveAmount==='credit' → income → goes to the
 *     category node it offsets (so a refund nets the category's spend).
 *   - Positive + classifyPositiveAmount==='payment' → SKIP. Statement
 *     payments aren't income or category signal.
 *   - Positive + isNonSpend (income/refund/reward) → INCOME source.
 *
 * For two-layer Sankey we model:
 *   INCOME → category (or business sink). Refund/reward credits net the
 *   category sink (subtract from category spend) rather than appearing as
 *   their own flow — same semantics as dashboard `netSpend`.
 */
export function aggregateSankey(
  rows: SankeyTxnRow[],
  currency: string,
  opts: AggregateOptions = {},
): SankeyResult {
  const topN = opts.topCategories ?? DEFAULT_TOP_CATEGORIES;

  // --------- Pass 1: classify each row and accumulate buckets ----------
  type CategoryBucket = {
    label: string;
    netSpend: number;
    txnIds: number[];
  };
  // Keyed by the resolved category label (or 'Uncategorized'); negatives
  // contribute totalSpend, positive credits reduce it.
  const categoryBuckets = new Map<string, CategoryBucket>();

  // Business sink is a separate bucket — distinct from any user category
  // because business spend has a different financial meaning (deductible
  // expense, not consumption). Negative business rows route here.
  const businessBucket: CategoryBucket = {
    label: 'Business spending',
    netSpend: 0,
    txnIds: [],
  };

  let totalIncome = 0;
  const incomeTxnIds: number[] = [];
  let totalTransactionCount = 0;

  for (const row of rows) {
    if (row.currency !== currency) continue;
    const amount = num(row.amount);
    if (amount == null) continue;
    // Money movement (transfers/invest/dividends, or any investment-account
    // row) is not income or spend in the Sankey sense.
    if (isNonCategorical(row.txnType, row.accountType)) continue;

    totalTransactionCount += 1;
    const nonSpend = isNonSpend(row.txnType, row.accountType);

    if (amount < 0 && !nonSpend) {
      // -------- SPEND row ------------------------------------------------
      const spend = -amount;
      if (row.finalBusiness) {
        businessBucket.netSpend += spend;
        businessBucket.txnIds.push(row.id);
      } else {
        const label = resolveCategoryLabel(row);
        const bucket = categoryBuckets.get(label) ?? {
          label,
          netSpend: 0,
          txnIds: [],
        };
        bucket.netSpend += spend;
        bucket.txnIds.push(row.id);
        categoryBuckets.set(label, bucket);
      }
      continue;
    }

    if (amount > 0) {
      // -------- POSITIVE row — split by classifier ----------------------
      const bucket = classifyPositiveAmount({
        txnType: row.txnType,
        accountType: row.accountType,
        merchantRaw: row.merchantRaw,
        merchantClean: row.merchantClean,
        category: row.finalCategory,
      });

      if (bucket === 'payment' || bucket === 'skip') {
        // Statement payment / non-categorical positive — not income, not
        // category signal. Excluded entirely.
        continue;
      }

      // bucket === 'credit'
      // Two sub-cases by txnType:
      //   - txnType='income' → primary INCOME source (paycheque, etc.)
      //   - refund/reward (or fallback credit) → net against the category
      //     it offset, same semantics as dashboard's netSpend.
      if (row.txnType === 'income') {
        totalIncome += amount;
        incomeTxnIds.push(row.id);
        continue;
      }

      // refund / reward / unspecified credit → reduces category netSpend.
      // Routed to the business bucket if business=true, otherwise to the
      // row's resolved category.
      if (row.finalBusiness) {
        businessBucket.netSpend -= amount;
        businessBucket.txnIds.push(row.id);
      } else {
        const label = resolveCategoryLabel(row);
        const cat = categoryBuckets.get(label) ?? {
          label,
          netSpend: 0,
          txnIds: [],
        };
        cat.netSpend -= amount;
        cat.txnIds.push(row.id);
        categoryBuckets.set(label, cat);
      }
      continue;
    }

    // amount === 0 or amount < 0 + nonSpend (e.g. refund negative) — skip.
  }

  // --------- Pass 2: cap category count, build nodes + links ----------
  // Categories sort by netSpend desc; ties broken by name.
  const categories = Array.from(categoryBuckets.values())
    .filter((c) => c.netSpend > 0 || c.txnIds.length > 0)
    .sort((a, b) => {
      if (b.netSpend !== a.netSpend) return b.netSpend - a.netSpend;
      return a.label.localeCompare(b.label);
    });

  let visibleCategories = categories;
  let otherBucket: CategoryBucket | null = null;
  if (categories.length > topN) {
    visibleCategories = categories.slice(0, topN);
    const overflow = categories.slice(topN);
    otherBucket = {
      label: OTHER_CATEGORIES_LABEL,
      netSpend: overflow.reduce((sum, c) => sum + c.netSpend, 0),
      txnIds: overflow.flatMap((c) => c.txnIds),
    };
  }

  const sinkBuckets: CategoryBucket[] = [];
  for (const c of visibleCategories) {
    // Drop categories whose net is ≤ 0 (refund/reward exceeded spend). They
    // would render as zero-width links, which recharts handles poorly.
    if (c.netSpend > 0) sinkBuckets.push(c);
  }
  if (otherBucket && otherBucket.netSpend > 0) sinkBuckets.push(otherBucket);
  if (businessBucket.netSpend > 0) sinkBuckets.push(businessBucket);

  // Compute totalSpend from the FINAL buckets (post-overflow, post-business
  // routing) so it reconciles with the rendered link widths.
  const totalSpend = sinkBuckets.reduce((sum, b) => sum + b.netSpend, 0);

  // -------- Empty state ----------------------------------------------
  if (totalIncome === 0 && totalSpend === 0) {
    return {
      currency,
      totalIncome: 0,
      totalSpend: 0,
      transactionCount: totalTransactionCount,
      nodes: [],
      links: [],
      edgeMap: new Map(),
    };
  }

  // -------- Build the Sankey shape ----------------------------------
  // Node order:
  //   [0] Income source (always present if totalIncome>0 OR totalSpend>0)
  //   [1..N] category sinks
  // Recharts Sankey wants a single linear node array; links reference by index.
  const nodes: SankeyNode[] = [{ name: INCOME_LABEL, kind: 'income' }];

  // Track txnIds at the income side too: the link from Income to each
  // category carries the income+spend txns that contributed.
  const links: SankeyLink[] = [];
  const edgeMap = new Map<string, number[]>();

  for (const sink of sinkBuckets) {
    const targetIdx = nodes.length;
    let kind: SankeyNodeKind = 'category';
    if (sink.label === businessBucket.label) kind = 'business';
    else if (sink.label === UNCATEGORIZED_LABEL) kind = 'uncategorized';
    nodes.push({ name: sink.label, kind });

    links.push({ source: 0, target: targetIdx, value: sink.netSpend });
    edgeMap.set(`0-${targetIdx}`, sink.txnIds);
  }

  // Surface the income source IDs at edge "0-_income" so the drill-down
  // can return income rows when the income node itself is clicked.
  if (incomeTxnIds.length > 0) {
    edgeMap.set('income-source', incomeTxnIds);
  }

  return {
    currency,
    totalIncome,
    totalSpend,
    transactionCount: totalTransactionCount,
    nodes,
    links,
    edgeMap,
  };
}

/**
 * Convenience helper: given a SankeyResult and a clicked (source, target)
 * pair, returns the transaction IDs that contributed to that link, or
 * null if the link doesn't exist.
 */
export function lookupEdgeTxnIds(
  result: SankeyResult,
  source: number,
  target: number,
): number[] | null {
  const key = `${source}-${target}`;
  return result.edgeMap.get(key) ?? null;
}
