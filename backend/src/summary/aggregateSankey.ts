/**
 * Cashflow Sankey aggregator (issue #224; full-chain rebuild per
 * docs/superpowers/specs/2026-09-27-sankey-full-chain-design.md).
 *
 * Pure function: given a pre-filtered set of transaction rows (the route
 * applies visibility + currency + date where-clauses upstream) and the
 * household's category tree, returns the {nodes, links} shape consumed by
 * recharts' Sankey component, plus an `edgeMap` so the route can resolve a
 * clicked flow segment back into the underlying transaction IDs.
 *
 * Flow model — the full money chain
 * ---------------------------------
 *
 *   Income ─┬→ Corporate expenses                       (finalBusiness rows)
 *           └→ Owner draws ─┬→ category → subcategory → …
 *                           └→ Surplus                  (terminal)
 *
 * `finalBusiness` separates the corporate side from the personal side.
 * Corporate expenses hang directly off Income because they are paid before
 * anything is drawn out: omitting them would silently inflate what looks
 * available. Surplus is a terminal node so the chart balances — everything
 * in equals everything out.
 *
 * Adaptive depth
 * --------------
 * Categories are a tree (`CategoryTree`), and production chains run three
 * deep (`Hobbies → Golf → Clublink`). Rendering every level for every branch
 * produces ~40 nodes, most of them unreadable hairlines — so **depth follows
 * share**:
 *
 *   - A parent splits into its children only when its subtree total is at
 *     least `splitShare` of total spend. Below that it draws as ONE node
 *     carrying its whole subtree total — not splitting never drops value.
 *   - Inside a split, a child below `minNodeShare` of total spend is too thin
 *     to draw; it folds into the parent's remainder node (`"<Parent> (other)"`)
 *     alongside the parent's own direct charges. A parent charged directly AND
 *     through children therefore renders as parent → {children…, remainder},
 *     which sums to the parent's subtree total exactly once.
 *   - Both thresholds are shares of total spend, not absolutes, so they hold
 *     as the numbers grow.
 *
 * At the top level the tail is additionally capped by `topCategories`; the
 * overflow folds into a single "Other categories" node that keeps its rows.
 *
 * Internal-transfer handling
 * --------------------------
 * Transfers, investment purchases, and dividend reinvestments are
 * money-movement, not spending. `isNonCategorical` (the same gate used by
 * aggregateDashboard) drops them BEFORE bucketing — so the Sankey's
 * totalIncome and totalSpend reconcile against the dashboard headlines for
 * the same filter. `Transfer` alone is ~$493k in 2026 and would flatten
 * everything else into invisibility.
 *
 * Balance
 * -------
 * `balanced` is true when total inflow equals total outflow plus surplus.
 * When observed spend exceeds observed income the chart CANNOT balance; that
 * is a classification gap (an inflow typed `unknown`, say) and it surfaces as
 * `balanced: false` with a negative `surplus` rather than being absorbed into
 * an invented residual node.
 *
 * Money math runs in integer units (see util/numbers) and converts back to
 * dollars only at the output boundary.
 */
import type { CategoryTree } from '../categories/rollup';
import { num, toUnits, fromUnits } from '../util/numbers';
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
  /** Resolved category primary key — places the row in the category tree. */
  finalCategoryId?: number | null;
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
  | 'uncategorized'
  /** The owner-draws waypoint between corporate revenue and personal spend. */
  | 'draws'
  /** Terminal node carrying income that was not spent. */
  | 'surplus';

export interface SankeyNode {
  /** Display name. Unique per node in practice, but links reference indices. */
  name: string;
  kind: SankeyNodeKind;
  /**
   * The resolved category primary key for category nodes; null/undefined for
   * income, corporate, draws and surplus nodes. A `"<Parent> (other)"`
   * remainder node carries its parent's id — it is the parent's own spend
   * plus any children too thin to draw.
   */
  categoryId?: number | null;
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
  /** Sum of all income inflows (positive). 0 when no income observed. */
  totalIncome: number;
  /** Personal spend + corporate expenses (positive). */
  totalSpend: number;
  /** totalIncome - totalSpend. Negative when spend exceeds observed income. */
  surplus: number;
  /**
   * True when inflow equals outflow plus surplus — i.e. the chart closes.
   * False means observed spend exceeds observed income: a classification gap
   * that the caller should surface rather than hide.
   */
  balanced: boolean;
  /** Aggregate count of transaction rows that contributed to any link. */
  transactionCount: number;
  nodes: SankeyNode[];
  links: SankeyLink[];
  /**
   * Map of `"sourceIdx-targetIdx"` → ordered list of transaction IDs that
   * contributed to that link, at every depth. An edge into a node that was
   * drawn undivided carries its whole hidden subtree's rows. Used by the
   * drill-down endpoint. Also carries `"income-source"` for the income rows.
   */
  edgeMap: Map<string, number[]>;
  /**
   * DIRECT (not rolled-up) net spend per category id, including categories
   * that were collapsed out of the chart. Feeds the category rollup in the
   * route — reading it off the links would double-count, because a parent
   * link's value already contains its children.
   */
  spendByCategoryId: Map<number, number>;
}

/**
 * The top-level node count is capped so the Sankey stays readable. Top-level
 * categories beyond the cap (ranked by subtree total descending) fold into a
 * single "Other categories" node so totals still reconcile.
 */
export const DEFAULT_TOP_CATEGORIES = 12;

/**
 * Minimum share of total spend a node needs before it is split into its
 * children. 5% of a $133k year is ~$6.6k — roughly where a band stops being
 * worth subdividing.
 */
const DEFAULT_SPLIT_SHARE = 0.05;

/**
 * Minimum share of total spend a child needs to be drawn at all inside a
 * split. Below this it renders as a hairline, so it folds into its parent's
 * remainder node instead.
 */
const DEFAULT_MIN_NODE_SHARE = 0.01;

export const INCOME_LABEL = 'Income';
export const CORPORATE_LABEL = 'Corporate expenses';
export const DRAWS_LABEL = 'Owner draws';
export const SURPLUS_LABEL = 'Surplus';
export const OTHER_CATEGORIES_LABEL = 'Other categories';
const UNCATEGORIZED_LABEL = 'Uncategorized';
const REMAINDER_SUFFIX = ' (other)';

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
  /** Cap on top-level nodes; the tail collapses into "Other categories". */
  topCategories?: number;
  /**
   * Household category tree. Without it every category is a flat leaf (the
   * pre-hierarchy behaviour) — the chain and surplus still render.
   */
  categoryTree?: CategoryTree;
  /** Share of total spend a node needs before splitting. Default 5%. */
  splitShare?: number;
  /** Share of total spend a child needs to be drawn. Default 1%. */
  minNodeShare?: number;
}

/** One accumulation bucket: a category (by id when known) or a flat label. */
interface Bucket {
  label: string;
  /** Net spend in integer units; positive credits reduce it. */
  netU: number;
  txnIds: number[];
  /** Resolved category id, when the row carried one. */
  categoryId: number | null;
}

/** A top-level branch of the chart: a tree root, or a flat (id-less) bucket. */
interface Branch {
  label: string;
  totalU: number;
  /** Tree node id, or null for a flat bucket. */
  id: number | null;
  txnIds: number[];
  categoryId: number | null;
  kind: SankeyNodeKind;
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
 *   - Negative + !isNonSpend → spend → its category, OR the corporate sink if
 *     finalBusiness=true (which overrides category routing).
 *   - Positive + txnType='income' → the Income source.
 *   - Positive + classifyPositiveAmount==='credit' → nets the category it
 *     offsets, same semantics as the dashboard's netSpend.
 *   - Positive + classifyPositiveAmount==='payment'/'skip' → excluded.
 *     Statement payments and unsignalled deposits are neither income nor
 *     category signal.
 */
export function aggregateSankey(
  rows: SankeyTxnRow[],
  currency: string,
  opts: AggregateOptions = {},
): SankeyResult {
  const topN = opts.topCategories ?? DEFAULT_TOP_CATEGORIES;
  const splitShare = opts.splitShare ?? DEFAULT_SPLIT_SHARE;
  const minNodeShare = opts.minNodeShare ?? DEFAULT_MIN_NODE_SHARE;
  const tree = opts.categoryTree;

  // --------- Pass 1: classify each row and accumulate buckets ----------
  // Keyed by `id:<categoryId>` when the row's category is in the tree (so the
  // hierarchy can be walked), else by `name:<label>`.
  const buckets = new Map<string, Bucket>();
  const corporate: Bucket = {
    label: CORPORATE_LABEL,
    netU: 0,
    txnIds: [],
    categoryId: null,
  };

  let incomeU = 0;
  const incomeTxnIds: number[] = [];
  let totalTransactionCount = 0;

  /** Route one signed amount (in units) into the right category bucket. */
  const addToCategory = (row: SankeyTxnRow, deltaU: number): void => {
    const rowCategoryId = row.finalCategoryId ?? null;
    const inTree = rowCategoryId != null && tree?.parentById.has(rowCategoryId) === true;
    const label = inTree
      ? (tree?.nameById.get(rowCategoryId as number) ?? resolveCategoryLabel(row))
      : resolveCategoryLabel(row);
    const key = inTree ? `id:${rowCategoryId}` : `name:${label}`;
    const bucket = buckets.get(key) ?? {
      label,
      netU: 0,
      txnIds: [],
      categoryId: null,
    };
    bucket.netU += deltaU;
    bucket.txnIds.push(row.id);
    // Keep the first non-null categoryId seen for this bucket.
    if (bucket.categoryId === null && rowCategoryId !== null) {
      bucket.categoryId = rowCategoryId;
    }
    buckets.set(key, bucket);
  };

  for (const row of rows) {
    if (row.currency !== currency) continue;
    const amount = num(row.amount);
    if (amount == null) continue;
    // Money movement (transfers/invest/dividends, or any investment-account
    // row) is not income or spend in the Sankey sense.
    if (isNonCategorical(row.txnType, row.accountType)) continue;

    totalTransactionCount += 1;
    const nonSpend = isNonSpend(row.txnType, row.accountType);
    const amtU = toUnits(amount);

    if (amount < 0 && !nonSpend) {
      // -------- SPEND row ------------------------------------------------
      if (row.finalBusiness) {
        corporate.netU += -amtU;
        corporate.txnIds.push(row.id);
      } else {
        addToCategory(row, -amtU);
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
      if (bucket === 'payment' || bucket === 'skip') continue;

      if (row.txnType === 'income') {
        incomeU += amtU;
        incomeTxnIds.push(row.id);
        continue;
      }

      // refund / reward / unspecified credit → reduces net spend where it
      // landed (corporate or the row's category).
      if (row.finalBusiness) {
        corporate.netU -= amtU;
        corporate.txnIds.push(row.id);
      } else {
        addToCategory(row, -amtU);
      }
      continue;
    }

    // amount === 0, or negative + nonSpend (e.g. a negative refund) — skip.
  }

  // --------- Pass 2: clamp, roll up the tree, rank branches ------------
  // A bucket whose credits exceeded its spend nets ≤ 0; it contributes
  // nothing (a zero/negative-width link is noise, and the rows stay in the
  // underlying data). Clamping here keeps every subtree total non-negative,
  // so a parent's children always sum to exactly its own total.
  const effectiveU = new Map<string, number>();
  const spendByCategoryId = new Map<number, number>();
  for (const [key, bucket] of buckets) {
    const netU = Math.max(0, bucket.netU);
    effectiveU.set(key, netU);
    if (netU > 0 && bucket.categoryId != null) {
      spendByCategoryId.set(bucket.categoryId, fromUnits(netU));
    }
  }
  const corporateU = Math.max(0, corporate.netU);

  /** Own (direct) spend for a tree node id. */
  const ownU = (id: number): number => effectiveU.get(`id:${id}`) ?? 0;
  const ownIds = (id: number): number[] =>
    ownU(id) > 0 ? (buckets.get(`id:${id}`)?.txnIds ?? []) : [];

  // Relevant tree ids = every id with spend, plus their ancestors (an
  // ancestor with no direct spend still has to exist as a waypoint).
  const childrenById = new Map<number, number[]>();
  const relevant = new Set<number>();
  if (tree) {
    for (const [key, bucket] of buckets) {
      if (!key.startsWith('id:')) continue;
      if ((effectiveU.get(key) ?? 0) <= 0) continue;
      let cursor: number | null = bucket.categoryId;
      const seen = new Set<number>();
      while (cursor != null && tree.parentById.has(cursor) && !seen.has(cursor)) {
        seen.add(cursor);
        relevant.add(cursor);
        cursor = tree.parentById.get(cursor) ?? null;
      }
    }
    for (const id of relevant) {
      const parent = tree.parentById.get(id) ?? null;
      if (parent != null && relevant.has(parent)) {
        childrenById.set(parent, [...(childrenById.get(parent) ?? []), id]);
      }
    }
  }

  const subtreeCache = new Map<number, number>();
  const subtreeU = (id: number): number => {
    const cached = subtreeCache.get(id);
    if (cached != null) return cached;
    // Seed before recursing so a malformed (cyclic) tree terminates.
    subtreeCache.set(id, 0);
    let total = ownU(id);
    for (const child of childrenById.get(id) ?? []) total += subtreeU(child);
    subtreeCache.set(id, total);
    return total;
  };
  const subtreeIds = (id: number): number[] => {
    const out = [...ownIds(id)];
    for (const child of childrenById.get(id) ?? []) out.push(...subtreeIds(child));
    return out;
  };

  const displayName = (id: number): string =>
    tree?.nameById.get(id) ?? buckets.get(`id:${id}`)?.label ?? UNCATEGORIZED_LABEL;

  // Top-level branches: tree roots with spend, plus every flat bucket.
  const branches: Branch[] = [];
  for (const id of relevant) {
    const parent = tree?.parentById.get(id) ?? null;
    const isRoot = parent == null || !relevant.has(parent);
    if (!isRoot) continue;
    const totalU = subtreeU(id);
    if (totalU <= 0) continue;
    branches.push({
      label: displayName(id),
      totalU,
      id,
      txnIds: subtreeIds(id),
      categoryId: id,
      kind: 'category',
    });
  }
  for (const [key, bucket] of buckets) {
    if (key.startsWith('id:') && relevant.has(bucket.categoryId as number)) continue;
    const totalU = effectiveU.get(key) ?? 0;
    if (totalU <= 0) continue;
    branches.push({
      label: bucket.label,
      totalU,
      id: null,
      txnIds: bucket.txnIds,
      categoryId: bucket.categoryId,
      kind: bucket.label === UNCATEGORIZED_LABEL ? 'uncategorized' : 'category',
    });
  }
  const bySize = (a: Branch, b: Branch): number =>
    b.totalU !== a.totalU ? b.totalU - a.totalU : a.label.localeCompare(b.label);
  branches.sort(bySize);

  const personalU = branches.reduce((sum, b) => sum + b.totalU, 0);
  const totalSpendU = personalU + corporateU;
  const surplusU = incomeU - totalSpendU;

  // -------- Empty state ----------------------------------------------
  if (incomeU === 0 && totalSpendU === 0) {
    return {
      currency,
      totalIncome: 0,
      totalSpend: 0,
      surplus: 0,
      balanced: true,
      transactionCount: totalTransactionCount,
      nodes: [],
      links: [],
      edgeMap: new Map(),
      spendByCategoryId,
    };
  }

  const minSplitU = splitShare * totalSpendU;
  const minNodeU = minNodeShare * totalSpendU;

  // Tail: the top-N overflow plus any branch too thin to draw. A tail of
  // exactly one keeps its own name — relabelling a single category "Other
  // categories" would hide which one it was.
  const ranked = branches.slice(0, topN);
  const tail = [
    ...branches.slice(topN),
    ...ranked.filter((b) => b.totalU < minNodeU),
  ].sort(bySize);
  let visible = ranked.filter((b) => b.totalU >= minNodeU);
  if (tail.length === 1) {
    visible = [...visible, tail[0]].sort(bySize);
    tail.length = 0;
  }

  // -------- Build the Sankey shape ----------------------------------
  // Node order: Income, [Corporate expenses], [Owner draws], [Surplus], then
  // the category branches depth-first in rank order.
  const nodes: SankeyNode[] = [{ name: INCOME_LABEL, kind: 'income' }];
  const links: SankeyLink[] = [];
  const edgeMap = new Map<string, number[]>();

  const addLink = (source: number, target: number, valueU: number, txnIds: number[]): void => {
    if (valueU <= 0) return;
    links.push({ source, target, value: fromUnits(valueU) });
    if (txnIds.length > 0) edgeMap.set(`${source}-${target}`, txnIds);
  };

  if (corporateU > 0) {
    const corpIdx = nodes.length;
    nodes.push({ name: CORPORATE_LABEL, kind: 'business' });
    addLink(0, corpIdx, corporateU, corporate.txnIds);
  }

  const drawsOutU = personalU + Math.max(0, surplusU);
  let drawsIdx = -1;
  if (drawsOutU > 0) {
    drawsIdx = nodes.length;
    nodes.push({ name: DRAWS_LABEL, kind: 'draws' });
    addLink(0, drawsIdx, drawsOutU, incomeTxnIds);
    if (surplusU > 0) {
      const surplusIdx = nodes.length;
      nodes.push({ name: SURPLUS_LABEL, kind: 'surplus' });
      // Surplus is money that was NOT spent — no transactions flow through it.
      addLink(drawsIdx, surplusIdx, surplusU, []);
    }
  }

  /**
   * Emit one tree node under `parentIdx`, then recurse if its share of total
   * spend earns the split. The inbound link always carries the node's whole
   * subtree total, and any split sums back to exactly that.
   */
  const emitTreeNode = (id: number, parentIdx: number): void => {
    const idx = nodes.length;
    nodes.push({ name: displayName(id), kind: 'category', categoryId: id });
    addLink(parentIdx, idx, subtreeU(id), subtreeIds(id));

    if (subtreeU(id) < minSplitU) return; // too small to be worth the width
    const children = (childrenById.get(id) ?? [])
      .filter((c) => subtreeU(c) > 0)
      .sort((a, b) => subtreeU(b) - subtreeU(a) || displayName(a).localeCompare(displayName(b)));
    if (children.length === 0) return; // leaf

    let kept = children.filter((c) => subtreeU(c) >= minNodeU);
    let folded = children.filter((c) => subtreeU(c) < minNodeU);
    const direct = ownU(id);
    if (folded.length === 1 && direct === 0) {
      // A lone thin child with no sibling remainder keeps its own name.
      kept = [...kept, ...folded];
      folded = [];
    }
    if (kept.length === 0) return; // every child is a hairline — draw as one

    for (const child of kept) emitTreeNode(child, idx);

    const remainderU = direct + folded.reduce((sum, c) => sum + subtreeU(c), 0);
    if (remainderU > 0) {
      const remainderIdx = nodes.length;
      nodes.push({
        name: `${displayName(id)}${REMAINDER_SUFFIX}`,
        kind: 'category',
        categoryId: id,
      });
      addLink(idx, remainderIdx, remainderU, [
        ...ownIds(id),
        ...folded.flatMap((c) => subtreeIds(c)),
      ]);
    }
  };

  for (const branch of visible) {
    if (branch.id != null) {
      emitTreeNode(branch.id, drawsIdx);
      continue;
    }
    const idx = nodes.length;
    nodes.push({
      name: branch.label,
      kind: branch.kind,
      categoryId: branch.categoryId,
    });
    addLink(drawsIdx, idx, branch.totalU, branch.txnIds);
  }
  if (tail.length > 0) {
    const idx = nodes.length;
    nodes.push({ name: OTHER_CATEGORIES_LABEL, kind: 'category', categoryId: null });
    addLink(
      drawsIdx,
      idx,
      tail.reduce((sum, b) => sum + b.totalU, 0),
      tail.flatMap((b) => b.txnIds),
    );
  }

  // Surface the income rows under a stable key so the drill-down can return
  // them when the income node itself is clicked.
  if (incomeTxnIds.length > 0) edgeMap.set('income-source', incomeTxnIds);

  return {
    currency,
    totalIncome: fromUnits(incomeU),
    totalSpend: fromUnits(totalSpendU),
    surplus: fromUnits(surplusU),
    balanced: surplusU >= 0,
    transactionCount: totalTransactionCount,
    nodes,
    links,
    edgeMap,
    spendByCategoryId,
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
