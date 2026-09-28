/**
 * Unit tests for the pure aggregateSankey helper.
 *
 * The aggregator draws the full money chain:
 *
 *   Income ─┬→ Corporate expenses
 *           └→ Owner draws ─┬→ top-level categories → subcategories → …
 *                           └→ Surplus
 *
 * Covered here:
 *  - Flow totals match underlying transaction summaries (income, category
 *    netSpend, corporate spend separation, refund/reward netting).
 *  - The chart BALANCES: inflow = outflow + surplus, and every intermediate
 *    node's inflow equals its outflow.
 *  - Adaptive depth: a parent splits into children only when its share of
 *    total spend clears `splitShare`; below that it draws as one node
 *    carrying its whole subtree total (nothing is dropped by not splitting).
 *  - A parent with BOTH own spend and children keeps both without double
 *    counting (the remainder draws as a "(other)" child).
 *  - Drill-down survives depth: edgeMap resolves subcategory and
 *    sub-subcategory edges, not only top-level ones.
 *  - Internal transfers / investment purchases / dividend reinvestments are
 *    still dropped before bucketing (isNonCategorical).
 *  - Empty states, currency scoping, top-N tail collapse.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CategoryTree } from '../categories/rollup';
import {
  aggregateSankey,
  resolveCategoryLabel,
  lookupEdgeTxnIds,
  CORPORATE_LABEL,
  DRAWS_LABEL,
  INCOME_LABEL,
  SURPLUS_LABEL,
  OTHER_CATEGORIES_LABEL,
  type SankeyResult,
  type SankeyTxnRow,
} from './aggregateSankey';

function row(overrides: Partial<SankeyTxnRow> & { id: number }): SankeyTxnRow {
  return {
    id: overrides.id,
    date: overrides.date ?? '2026-03-15',
    currency: overrides.currency ?? 'CAD',
    finalCategory: overrides.finalCategory ?? null,
    finalCategoryId: overrides.finalCategoryId ?? null,
    finalBusiness: overrides.finalBusiness ?? false,
    merchantRaw: overrides.merchantRaw ?? 'Test merchant',
    merchantClean: overrides.merchantClean ?? overrides.merchantRaw ?? 'Test merchant',
    amount: overrides.amount ?? '-10.00',
    txnType: overrides.txnType ?? 'purchase',
    accountType: overrides.accountType ?? 'credit',
  };
}

/**
 * `id` plus its ancestors that are present in the map, ROOT FIRST. The walk
 * stops at a parent the map does not know (or a null one), which is exactly
 * what makes that node a root — so the chain length is the node's depth + 1.
 */
function ancestryOf(id: number, parentById: Map<number, number | null>): number[] {
  const chain: number[] = [];
  let cursor: number | null = id;
  while (cursor != null && parentById.has(cursor)) {
    chain.push(cursor);
    cursor = parentById.get(cursor) ?? null;
  }
  return chain.reverse();
}

/**
 * Build a CategoryTree from `[id, name, parentId]` triples — the same shape
 * `loadCategoryTree` produces, without touching the DB.
 */
function tree(defs: Array<[number, string, number | null]>): CategoryTree {
  const parentById = new Map<number, number | null>();
  const nameById = new Map<number, string>();
  for (const [id, name, parentId] of defs) {
    parentById.set(id, parentId);
    nameById.set(id, name);
  }
  const depthById = new Map<number, number>();
  const pathById = new Map<number, string>();
  for (const id of parentById.keys()) {
    const chain = ancestryOf(id, parentById);
    depthById.set(id, chain.length - 1);
    pathById.set(id, chain.map((n) => nameById.get(n) ?? '').join(' / '));
  }
  return { parentById, nameById, depthById, pathById };
}

const nameOf = (r: SankeyResult, idx: number): string => r.nodes[idx]?.name ?? '';
const idxOf = (r: SankeyResult, name: string): number =>
  r.nodes.findIndex((n) => n.name === name);
const linkValue = (r: SankeyResult, from: string, to: string): number | undefined =>
  r.links.find(
    (l) => nameOf(r, l.source) === from && nameOf(r, l.target) === to,
  )?.value;
const edgeIds = (r: SankeyResult, from: string, to: string): number[] | null => {
  const link = r.links.find(
    (l) => nameOf(r, l.source) === from && nameOf(r, l.target) === to,
  );
  if (!link) return null;
  return lookupEdgeTxnIds(r, link.source, link.target);
};

/** Property 1: every link is drawable — real width, real endpoints. */
function assertLinksWellFormed(r: SankeyResult): void {
  for (const l of r.links) {
    assert.ok(l.value > 0, 'no zero/negative-width links');
    assert.ok(l.source >= 0 && l.source < r.nodes.length, 'source in range');
    assert.ok(l.target >= 0 && l.target < r.nodes.length, 'target in range');
    assert.notEqual(l.source, l.target, 'no self links');
  }
}

/** Inbound and outbound link value totals, per node index. */
function flowSums(r: SankeyResult): {
  inSum: Map<number, number>;
  outSum: Map<number, number>;
} {
  const inSum = new Map<number, number>();
  const outSum = new Map<number, number>();
  for (const l of r.links) {
    inSum.set(l.target, (inSum.get(l.target) ?? 0) + l.value);
    outSum.set(l.source, (outSum.get(l.source) ?? 0) + l.value);
  }
  return { inSum, outSum };
}

/**
 * Property 2, for one node: the income source is the only one with no inbound
 * link, nothing else is orphaned, and an intermediate node passes on everything
 * it received — no leakage, no invention. Compared in cents to tolerate float
 * division at the fromUnits boundary.
 */
function assertNodeBalanced(
  r: SankeyResult,
  i: number,
  inflow: number,
  outflow: number,
): void {
  if (i === 0) {
    assert.equal(inflow, 0, 'the income node has no inbound link');
    return;
  }
  assert.ok(inflow > 0, `node ${i} (${nameOf(r, i)}) is not orphaned`);
  if (outflow <= 0) return; // terminal node — this is where the money stops
  assert.equal(
    Math.round(inflow * 100),
    Math.round(outflow * 100),
    `node ${i} (${nameOf(r, i)}) conserves value`,
  );
}

/** Property 2: every node is reached, and every intermediate one conserves. */
function assertNodesBalanced(r: SankeyResult): void {
  const { inSum, outSum } = flowSums(r);
  for (let i = 0; i < r.nodes.length; i += 1) {
    assertNodeBalanced(r, i, inSum.get(i) ?? 0, outSum.get(i) ?? 0);
  }
}

/**
 * Structural invariants every result must satisfy. Asserted by most tests —
 * a Sankey whose node in/out sums disagree is silently losing money.
 */
function assertStructurallySound(r: SankeyResult): void {
  assertLinksWellFormed(r);
  assertNodesBalanced(r);
}

// ---- resolveCategoryLabel ----------------------------------------------

test('resolveCategoryLabel: trimmed category wins', () => {
  assert.equal(resolveCategoryLabel({ finalCategory: 'Groceries' }), 'Groceries');
  assert.equal(resolveCategoryLabel({ finalCategory: '  Dining  ' }), 'Dining');
});

test('resolveCategoryLabel: null/empty falls back to Uncategorized', () => {
  assert.equal(resolveCategoryLabel({ finalCategory: null }), 'Uncategorized');
  assert.equal(resolveCategoryLabel({ finalCategory: '' }), 'Uncategorized');
  assert.equal(resolveCategoryLabel({ finalCategory: '   ' }), 'Uncategorized');
});

// ---- Empty states ------------------------------------------------------

test('aggregateSankey: empty input → empty nodes + zero totals', () => {
  const result = aggregateSankey([], 'CAD');
  assert.equal(result.totalIncome, 0);
  assert.equal(result.totalSpend, 0);
  assert.equal(result.surplus, 0);
  assert.equal(result.balanced, true);
  assert.equal(result.transactionCount, 0);
  assert.deepEqual(result.nodes, []);
  assert.deepEqual(result.links, []);
});

test('aggregateSankey: only transfers → empty (no double counting)', () => {
  const rows: SankeyTxnRow[] = [
    row({ id: 1, amount: '-500.00', txnType: 'transfer' }),
    row({ id: 2, amount: '500.00', txnType: 'transfer' }),
    row({ id: 3, amount: '-1000.00', txnType: 'investment' }),
    row({ id: 4, amount: '1000.00', txnType: 'dividend' }),
  ];
  const result = aggregateSankey(rows, 'CAD');
  assert.equal(result.totalIncome, 0);
  assert.equal(result.totalSpend, 0);
  assert.equal(result.transactionCount, 0); // isNonCategorical drops before counting
  assert.deepEqual(result.nodes, []);
  assert.deepEqual(result.links, []);
});

test('aggregateSankey: only an investment-account negative row is dropped', () => {
  const rows: SankeyTxnRow[] = [
    row({ id: 1, amount: '-2500.00', accountType: 'investment', txnType: null }),
  ];
  const result = aggregateSankey(rows, 'CAD');
  assert.equal(result.totalSpend, 0);
  assert.deepEqual(result.nodes, []);
});

// ---- The chain: Income → corporate / draws → categories → surplus ------

test('aggregateSankey: draws the full corporate-to-personal chain', () => {
  const rows: SankeyTxnRow[] = [
    row({ id: 1, amount: '10000.00', txnType: 'income', merchantRaw: 'CDG LABS' }),
    row({ id: 2, amount: '-400.00', finalCategory: 'Hosting', finalBusiness: true }),
    row({ id: 3, amount: '-600.00', finalCategory: 'Groceries' }),
    row({ id: 4, amount: '-1000.00', finalCategory: 'Rent' }),
  ];
  const result = aggregateSankey(rows, 'CAD');
  assertStructurallySound(result);

  assert.equal(nameOf(result, 0), INCOME_LABEL);
  assert.equal(result.nodes[0].kind, 'income');
  const corp = result.nodes[idxOf(result, CORPORATE_LABEL)];
  assert.equal(corp.kind, 'business');
  const draws = result.nodes[idxOf(result, DRAWS_LABEL)];
  assert.equal(draws.kind, 'draws');
  const surplus = result.nodes[idxOf(result, SURPLUS_LABEL)];
  assert.equal(surplus.kind, 'surplus');

  // Corporate expenses hang off Income directly — they never pass through draws.
  assert.equal(linkValue(result, INCOME_LABEL, CORPORATE_LABEL), 400);
  // Draws carry everything else: personal spend + surplus.
  assert.equal(linkValue(result, INCOME_LABEL, DRAWS_LABEL), 10000 - 400);
  assert.equal(linkValue(result, DRAWS_LABEL, 'Rent'), 1000);
  assert.equal(linkValue(result, DRAWS_LABEL, 'Groceries'), 600);
  assert.equal(linkValue(result, DRAWS_LABEL, SURPLUS_LABEL), 10000 - 400 - 1600);

  assert.equal(result.totalIncome, 10000);
  assert.equal(result.totalSpend, 2000);
  assert.equal(result.surplus, 8000);
  assert.equal(result.balanced, true);
});

test('aggregateSankey: the chart balances — inflow = outflow + surplus', () => {
  const rows: SankeyTxnRow[] = [
    row({ id: 1, amount: '4200.55', txnType: 'income' }),
    row({ id: 2, amount: '-123.45', finalCategory: 'Groceries' }),
    row({ id: 3, amount: '-67.89', finalCategory: 'Transport' }),
    row({ id: 4, amount: '-19.99', finalCategory: null }),
    row({ id: 5, amount: '-250.01', finalCategory: 'Accounting', finalBusiness: true }),
    // Money movement — must not tilt the balance.
    row({ id: 6, amount: '-9000.00', txnType: 'transfer' }),
  ];
  const result = aggregateSankey(rows, 'CAD');
  assertStructurallySound(result);

  const outOfIncome = result.links
    .filter((l) => l.source === 0)
    .reduce((s, l) => s + l.value, 0);
  assert.equal(
    Math.round(outOfIncome * 100),
    Math.round(result.totalIncome * 100),
    'everything in flows back out',
  );
  assert.equal(
    Math.round((result.totalSpend + result.surplus) * 100),
    Math.round(result.totalIncome * 100),
  );
  assert.equal(result.balanced, true);
});

test('aggregateSankey: spend exceeding income surfaces as unbalanced, not a fudge node', () => {
  const rows: SankeyTxnRow[] = [
    row({ id: 1, amount: '500.00', txnType: 'income' }),
    row({ id: 2, amount: '-800.00', finalCategory: 'Rent' }),
  ];
  const result = aggregateSankey(rows, 'CAD');
  assertStructurallySound(result);
  assert.equal(result.totalIncome, 500);
  assert.equal(result.totalSpend, 800);
  assert.equal(result.surplus, -300);
  assert.equal(result.balanced, false);
  // No surplus node, and no invented inflow to paper over the gap.
  assert.equal(idxOf(result, SURPLUS_LABEL), -1);
  const names = result.nodes.map((n) => n.name);
  assert.deepEqual(names, [INCOME_LABEL, DRAWS_LABEL, 'Rent']);
});

// ---- Currency scoping --------------------------------------------------

test('aggregateSankey: filters by currency', () => {
  const rows: SankeyTxnRow[] = [
    row({ id: 1, amount: '-100.00', currency: 'CAD', finalCategory: 'Groceries' }),
    row({ id: 2, amount: '-50.00', currency: 'USD', finalCategory: 'Groceries' }),
    row({ id: 3, amount: '300.00', currency: 'CAD', txnType: 'income' }),
  ];
  const cad = aggregateSankey(rows, 'CAD');
  assert.equal(cad.currency, 'CAD');
  assert.equal(cad.totalIncome, 300);
  assert.equal(cad.totalSpend, 100);
  assert.equal(cad.surplus, 200);

  const usd = aggregateSankey(rows, 'USD');
  assert.equal(usd.totalIncome, 0);
  assert.equal(usd.totalSpend, 50);
  assert.equal(usd.balanced, false);
  assert.equal(nameOf(usd, 0), INCOME_LABEL);
  assert.ok(idxOf(usd, 'Groceries') > 0);
});

// ---- Category bucketing (flat, no tree) --------------------------------

test('aggregateSankey: groups spend by finalCategory, ranked desc', () => {
  const rows: SankeyTxnRow[] = [
    row({ id: 1, amount: '-30.00', finalCategory: 'Groceries' }),
    row({ id: 2, amount: '-25.00', finalCategory: 'Groceries' }),
    row({ id: 3, amount: '-100.00', finalCategory: 'Rent' }),
    row({ id: 4, amount: '-20.00', finalCategory: null }),
    row({ id: 5, amount: '2000.00', txnType: 'income' }),
  ];
  const result = aggregateSankey(rows, 'CAD');
  assertStructurallySound(result);
  assert.equal(result.totalSpend, 100 + 55 + 20);
  // Ranked by subtree total descending under Owner draws.
  const drawsIdx = idxOf(result, DRAWS_LABEL);
  const categoryTargets = result.links
    .filter((l) => l.source === drawsIdx && nameOf(result, l.target) !== SURPLUS_LABEL)
    .map((l) => nameOf(result, l.target));
  assert.deepEqual(categoryTargets, ['Rent', 'Groceries', 'Uncategorized']);
  assert.equal(linkValue(result, DRAWS_LABEL, 'Groceries'), 55);
  const uncategorized = result.nodes[idxOf(result, 'Uncategorized')];
  assert.equal(uncategorized.kind, 'uncategorized');
});

test('aggregateSankey: corporate spend is separated from the same personal category', () => {
  const rows: SankeyTxnRow[] = [
    row({ id: 1, amount: '-200.00', finalCategory: 'Software', finalBusiness: true }),
    row({ id: 2, amount: '-50.00', finalCategory: 'Software', finalBusiness: false }),
    row({ id: 3, amount: '5000.00', txnType: 'income' }),
  ];
  const result = aggregateSankey(rows, 'CAD');
  assertStructurallySound(result);
  assert.equal(linkValue(result, INCOME_LABEL, CORPORATE_LABEL), 200);
  assert.equal(linkValue(result, DRAWS_LABEL, 'Software'), 50);
  assert.equal(result.totalSpend, 250);
  assert.deepEqual(edgeIds(result, INCOME_LABEL, CORPORATE_LABEL), [1]);
});

test('aggregateSankey: corporate expenses appear even when tiny next to personal spend', () => {
  // Production shape: $2,878 corporate against $133,079 personal. Omitting the
  // corporate side silently inflates what looks available.
  const rows: SankeyTxnRow[] = [
    row({ id: 1, amount: '140000.00', txnType: 'income' }),
    row({ id: 2, amount: '-2878.00', finalCategory: 'Hosting', finalBusiness: true }),
    row({ id: 3, amount: '-133079.00', finalCategory: 'Household' }),
  ];
  const result = aggregateSankey(rows, 'CAD');
  assertStructurallySound(result);
  assert.equal(linkValue(result, INCOME_LABEL, CORPORATE_LABEL), 2878);
  assert.equal(result.surplus, 140000 - 2878 - 133079);
});

// ---- Refund / reward netting -------------------------------------------

test('aggregateSankey: refund row reduces its category netSpend', () => {
  const rows: SankeyTxnRow[] = [
    row({ id: 1, amount: '-100.00', finalCategory: 'Groceries' }),
    row({ id: 2, amount: '25.00', finalCategory: 'Groceries', txnType: 'refund' }),
    row({ id: 3, amount: '1000.00', txnType: 'income' }),
  ];
  const result = aggregateSankey(rows, 'CAD');
  assert.equal(linkValue(result, DRAWS_LABEL, 'Groceries'), 75);
  assert.equal(result.totalSpend, 75);
});

test('aggregateSankey: a refund that fully offsets spend drops the category', () => {
  const rows: SankeyTxnRow[] = [
    row({ id: 1, amount: '-50.00', finalCategory: 'Returns' }),
    row({ id: 2, amount: '50.00', finalCategory: 'Returns', txnType: 'refund' }),
    row({ id: 3, amount: '500.00', txnType: 'income' }),
  ];
  const result = aggregateSankey(rows, 'CAD');
  assertStructurallySound(result);
  assert.equal(idxOf(result, 'Returns'), -1);
  assert.equal(result.totalSpend, 0);
  assert.equal(result.surplus, 500);
});

test('aggregateSankey: statement payment positives are excluded from category & income', () => {
  const rows: SankeyTxnRow[] = [
    row({ id: 1, amount: '-200.00', finalCategory: 'Groceries' }),
    row({
      id: 2,
      amount: '200.00',
      finalCategory: 'Groceries',
      txnType: 'payment',
      merchantRaw: 'ONLINE PAYMENT THANK YOU',
    }),
    row({ id: 3, amount: '1000.00', txnType: 'income' }),
  ];
  const result = aggregateSankey(rows, 'CAD');
  assert.equal(linkValue(result, DRAWS_LABEL, 'Groceries'), 200);
  assert.equal(result.totalIncome, 1000);
});

// ---- Adaptive depth ----------------------------------------------------

const HOUSEHOLD_TREE = tree([
  [1, 'Household', null],
  [2, 'Rent', 1],
  [3, 'Groceries', 1],
  [4, 'Healthcare', null],
  [5, 'Diabetes', 4],
  [6, 'Dentist', 4],
]);

test('aggregateSankey: a large parent splits into its children', () => {
  const rows: SankeyTxnRow[] = [
    row({ id: 1, amount: '-2000.00', finalCategory: 'Rent', finalCategoryId: 2 }),
    row({ id: 2, amount: '-1000.00', finalCategory: 'Groceries', finalCategoryId: 3 }),
    row({ id: 3, amount: '5000.00', txnType: 'income' }),
  ];
  const result = aggregateSankey(rows, 'CAD', { categoryTree: HOUSEHOLD_TREE });
  assertStructurallySound(result);
  // Household is 100% of spend → splits.
  assert.equal(linkValue(result, DRAWS_LABEL, 'Household'), 3000);
  assert.equal(linkValue(result, 'Household', 'Rent'), 2000);
  assert.equal(linkValue(result, 'Household', 'Groceries'), 1000);
  // Owner draws never link straight to a subcategory.
  assert.equal(linkValue(result, DRAWS_LABEL, 'Rent'), undefined);
});

test('aggregateSankey: a small parent stays whole and keeps its full subtree total', () => {
  const rows: SankeyTxnRow[] = [
    // Household is 97% of spend; Healthcare is 3% — below the 5% default.
    row({ id: 1, amount: '-97000.00', finalCategory: 'Rent', finalCategoryId: 2 }),
    row({ id: 2, amount: '-2000.00', finalCategory: 'Diabetes', finalCategoryId: 5 }),
    row({ id: 3, amount: '-1000.00', finalCategory: 'Dentist', finalCategoryId: 6 }),
    row({ id: 4, amount: '200000.00', txnType: 'income' }),
  ];
  const result = aggregateSankey(rows, 'CAD', { categoryTree: HOUSEHOLD_TREE });
  assertStructurallySound(result);
  // Collapsed: one Healthcare node carrying Diabetes + Dentist.
  assert.equal(linkValue(result, DRAWS_LABEL, 'Healthcare'), 3000);
  assert.equal(idxOf(result, 'Diabetes'), -1);
  assert.equal(idxOf(result, 'Dentist'), -1);
  // Not splitting never means dropping value.
  assert.equal(result.totalSpend, 100000);
  // …and the collapsed edge still resolves to every contributing row.
  assert.deepEqual(edgeIds(result, DRAWS_LABEL, 'Healthcare')?.slice().sort(), [2, 3]);
});

test('aggregateSankey: splitShare is a parameter, not a buried constant', () => {
  const rows: SankeyTxnRow[] = [
    row({ id: 1, amount: '-97000.00', finalCategory: 'Rent', finalCategoryId: 2 }),
    row({ id: 2, amount: '-2000.00', finalCategory: 'Diabetes', finalCategoryId: 5 }),
    row({ id: 3, amount: '-1000.00', finalCategory: 'Dentist', finalCategoryId: 6 }),
  ];
  // Lower the bar to 1% and Healthcare (3%) splits; raise it to 99% and even
  // Household stops splitting.
  const deep = aggregateSankey(rows, 'CAD', {
    categoryTree: HOUSEHOLD_TREE,
    splitShare: 0.01,
    minNodeShare: 0,
  });
  assertStructurallySound(deep);
  assert.equal(linkValue(deep, 'Healthcare', 'Diabetes'), 2000);
  assert.equal(linkValue(deep, 'Healthcare', 'Dentist'), 1000);

  const shallow = aggregateSankey(rows, 'CAD', {
    categoryTree: HOUSEHOLD_TREE,
    splitShare: 0.99,
  });
  assertStructurallySound(shallow);
  assert.equal(linkValue(shallow, DRAWS_LABEL, 'Household'), 97000);
  assert.equal(idxOf(shallow, 'Rent'), -1);
});

test('aggregateSankey: a parent with own spend AND children keeps both, without double counting', () => {
  const rows: SankeyTxnRow[] = [
    // Household charged directly…
    row({ id: 1, amount: '-4000.00', finalCategory: 'Household', finalCategoryId: 1 }),
    // …as well as through its children.
    row({ id: 2, amount: '-3000.00', finalCategory: 'Rent', finalCategoryId: 2 }),
    row({ id: 3, amount: '-3000.00', finalCategory: 'Groceries', finalCategoryId: 3 }),
    row({ id: 4, amount: '20000.00', txnType: 'income' }),
  ];
  const result = aggregateSankey(rows, 'CAD', { categoryTree: HOUSEHOLD_TREE });
  assertStructurallySound(result);
  assert.equal(linkValue(result, DRAWS_LABEL, 'Household'), 10000);
  assert.equal(linkValue(result, 'Household', 'Rent'), 3000);
  assert.equal(linkValue(result, 'Household', 'Groceries'), 3000);
  // The parent's own charge draws as its own terminal node — the subtree total
  // is the sum of the split, never the parent counted twice.
  assert.equal(linkValue(result, 'Household', 'Household (other)'), 4000);
  assert.equal(result.totalSpend, 10000);
  assert.deepEqual(edgeIds(result, 'Household', 'Household (other)'), [1]);
});

test('aggregateSankey: hairline children fold into the parent remainder', () => {
  const rows: SankeyTxnRow[] = [
    row({ id: 1, amount: '-5000.00', finalCategory: 'Rent', finalCategoryId: 2 }),
    // 0.2% of spend each — too thin to draw; they must not vanish either.
    row({ id: 2, amount: '-10.00', finalCategory: 'Groceries', finalCategoryId: 3 }),
    row({ id: 3, amount: '-10.00', finalCategory: 'Household', finalCategoryId: 1 }),
  ];
  const result = aggregateSankey(rows, 'CAD', { categoryTree: HOUSEHOLD_TREE });
  assertStructurallySound(result);
  assert.equal(idxOf(result, 'Groceries'), -1);
  assert.equal(linkValue(result, 'Household', 'Household (other)'), 20);
  assert.equal(result.totalSpend, 5020);
  // Drill-down on the remainder returns the folded children's rows too.
  assert.deepEqual(edgeIds(result, 'Household', 'Household (other)')?.slice().sort(), [2, 3]);
});

test('aggregateSankey: a lone folded child keeps its own name rather than becoming "(other)"', () => {
  const rows: SankeyTxnRow[] = [
    row({ id: 1, amount: '-5000.00', finalCategory: 'Rent', finalCategoryId: 2 }),
    row({ id: 2, amount: '-10.00', finalCategory: 'Groceries', finalCategoryId: 3 }),
  ];
  const result = aggregateSankey(rows, 'CAD', { categoryTree: HOUSEHOLD_TREE });
  assertStructurallySound(result);
  // Household has no own spend and only one thin child — relabelling it
  // "Household (other)" would hide which category it was.
  assert.equal(linkValue(result, 'Household', 'Groceries'), 10);
  assert.equal(idxOf(result, 'Household (other)'), -1);
});

// ---- Three-deep chains (production shape) ------------------------------

const PROD_TREE = tree([
  [1, 'Household', null],
  [2, 'Rent', 1],
  [3, 'Eating Out', 1],
  [4, 'Groceries', 1],
  [5, 'Clothing', 1],
  [6, 'Snowboarding Gear', 5],
  [10, 'Hobbies', null],
  [11, 'Golf', 10],
  [12, 'Clublink', 11],
  [13, 'Racing', 10],
  [14, 'Games', 10],
  [20, 'Amazon', null],
  [21, 'Healthcare', null],
  [22, 'Diabetes', 21],
  [23, 'Dentist', 21],
]);

function prodRows(): SankeyTxnRow[] {
  const spend: Array<[number, number, string, number]> = [
    // id, amount, label, categoryId
    [101, -20313, 'Rent', 2],
    [102, -15024, 'Eating Out', 3],
    [103, -13763, 'Groceries', 4],
    [104, -1122, 'Clothing', 5],
    [105, -6616, 'Household', 1],
    [201, -34308, 'Clublink', 12],
    [202, -4938, 'Golf', 11],
    [203, -2131, 'Racing', 13],
    [204, -599, 'Games', 14],
    [301, -14580, 'Amazon', 20],
    [401, -3997, 'Diabetes', 22],
    [402, -693, 'Dentist', 23],
  ];
  const rows: SankeyTxnRow[] = spend.map(([id, amount, label, categoryId]) =>
    row({ id, amount: String(amount), finalCategory: label, finalCategoryId: categoryId }),
  );
  rows.push(
    row({ id: 900, amount: '-2878.00', finalCategory: 'Hosting', finalBusiness: true }),
    row({ id: 901, amount: '132734.00', txnType: 'income', merchantRaw: 'CDG LABS' }),
    // Money movement dwarfs everything and must stay out.
    row({ id: 902, amount: '-493174.00', txnType: 'transfer' }),
  );
  return rows;
}

test('aggregateSankey: production shape renders three levels and stays readable', () => {
  const result = aggregateSankey(prodRows(), 'CAD', { categoryTree: PROD_TREE });
  assertStructurallySound(result);

  // Three deep where the money is: Hobbies → Golf → Clublink.
  assert.equal(linkValue(result, DRAWS_LABEL, 'Hobbies'), 34308 + 4938 + 2131 + 599);
  assert.equal(linkValue(result, 'Hobbies', 'Golf'), 34308 + 4938);
  assert.equal(linkValue(result, 'Golf', 'Clublink'), 34308);
  assert.equal(linkValue(result, 'Golf', 'Golf (other)'), 4938);

  // Household splits; its thin children fold into the remainder.
  assert.equal(linkValue(result, DRAWS_LABEL, 'Household'), 20313 + 15024 + 13763 + 1122 + 6616);
  assert.equal(linkValue(result, 'Household', 'Rent'), 20313);
  assert.equal(idxOf(result, 'Snowboarding Gear'), -1);

  // Leaves stay leaves; the small parent stays whole.
  assert.equal(linkValue(result, DRAWS_LABEL, 'Amazon'), 14580);
  assert.equal(linkValue(result, DRAWS_LABEL, 'Healthcare'), 3997 + 693);
  assert.equal(idxOf(result, 'Diabetes'), -1);

  // Transfers excluded; corporate present; the chart balances.
  const personal = 56838 + 41976 + 14580 + 4690;
  assert.equal(result.totalSpend, personal + 2878);
  assert.equal(linkValue(result, INCOME_LABEL, CORPORATE_LABEL), 2878);
  assert.equal(result.balanced, true);

  // Readable: ~20 nodes, not the ~40 a full render would produce.
  assert.ok(
    result.nodes.length <= 24,
    `expected a readable node count, got ${result.nodes.length}`,
  );
});

test('aggregateSankey: drill-down survives depth (subcategory + sub-subcategory edges)', () => {
  const result = aggregateSankey(prodRows(), 'CAD', { categoryTree: PROD_TREE });
  // Depth 3 edge.
  assert.deepEqual(edgeIds(result, 'Golf', 'Clublink'), [201]);
  // Depth 2 edge carries the whole subtree beneath it.
  assert.deepEqual(edgeIds(result, 'Hobbies', 'Golf')?.slice().sort((a, b) => a - b), [201, 202]);
  // Depth 1 edge likewise.
  assert.deepEqual(
    edgeIds(result, DRAWS_LABEL, 'Hobbies')?.slice().sort((a, b) => a - b),
    [201, 202, 203, 204],
  );
  // A collapsed parent resolves to its hidden children.
  assert.deepEqual(
    edgeIds(result, DRAWS_LABEL, 'Healthcare')?.slice().sort((a, b) => a - b),
    [401, 402],
  );
  // Unknown edge → null.
  assert.equal(lookupEdgeTxnIds(result, 0, 999), null);
});

test('aggregateSankey: spendByCategoryId reports DIRECT spend per category id', () => {
  const result = aggregateSankey(prodRows(), 'CAD', { categoryTree: PROD_TREE });
  // Direct, not rolled up: Hobbies itself was never charged.
  assert.equal(result.spendByCategoryId.get(11), 4938); // Golf, own
  assert.equal(result.spendByCategoryId.get(12), 34308); // Clublink
  assert.equal(result.spendByCategoryId.get(10), undefined); // Hobbies, no direct
  // Collapsed subcategories still report — the rollup must not lose them.
  assert.equal(result.spendByCategoryId.get(22), 3997); // Diabetes
});

// ---- Top-N tail collapse ----------------------------------------------

test('aggregateSankey: surplus top-level categories collapse into "Other categories"', () => {
  const rows: SankeyTxnRow[] = [];
  for (let i = 0; i < 15; i += 1) {
    rows.push(
      row({
        id: i + 1,
        amount: `-${(15 - i) * 10}.00`,
        finalCategory: `Cat ${String.fromCharCode(65 + i)}`,
      }),
    );
  }
  const result = aggregateSankey(rows, 'CAD', { topCategories: 5 });
  assertStructurallySound(result);
  const drawsIdx = idxOf(result, DRAWS_LABEL);
  const targets = result.links
    .filter((l) => l.source === drawsIdx)
    .map((l) => nameOf(result, l.target));
  assert.equal(targets.length, 6); // 5 named + the tail
  assert.ok(targets.includes(OTHER_CATEGORIES_LABEL));
  const expectedTotal = rows.reduce((sum, r) => sum + Math.abs(Number(r.amount)), 0);
  assert.equal(result.totalSpend, expectedTotal);
  // The tail keeps its rows for drill-down.
  const tailIds = edgeIds(result, DRAWS_LABEL, OTHER_CATEGORIES_LABEL);
  assert.equal(tailIds?.length, 10);
});

// ---- Edge map / income source -----------------------------------------

test('aggregateSankey: income-source bucket carries its own edgeMap key', () => {
  const rows: SankeyTxnRow[] = [
    row({ id: 10, amount: '5000.00', txnType: 'income' }),
    row({ id: 11, amount: '500.00', txnType: 'income' }),
    row({ id: 20, amount: '-50.00', finalCategory: 'Groceries' }),
  ];
  const result = aggregateSankey(rows, 'CAD');
  assert.deepEqual(result.edgeMap.get('income-source')?.slice().sort(), [10, 11]);
  // The Income → Owner draws edge drills into the income that funded it.
  assert.deepEqual(edgeIds(result, INCOME_LABEL, DRAWS_LABEL)?.slice().sort(), [10, 11]);
});

test('aggregateSankey: totalSpend reconciles with dashboard netSpend for a mixed ledger', () => {
  const rows: SankeyTxnRow[] = [
    row({ id: 1, amount: '-100.00', finalCategory: 'Groceries' }),
    row({ id: 2, amount: '25.00', finalCategory: 'Groceries', txnType: 'refund' }),
    row({ id: 3, amount: '-1500.00', txnType: 'investment', accountType: 'investment' }),
    row({ id: 4, amount: '-500.00', txnType: 'transfer' }),
    row({ id: 5, amount: '500.00', txnType: 'transfer' }),
    row({ id: 6, amount: '1000.00', txnType: 'income' }),
  ];
  const result = aggregateSankey(rows, 'CAD');
  assertStructurallySound(result);
  assert.equal(result.totalSpend, 75);
  assert.equal(result.totalIncome, 1000);
  assert.deepEqual(result.nodes.map((n) => n.name), [
    INCOME_LABEL,
    DRAWS_LABEL,
    SURPLUS_LABEL,
    'Groceries',
  ]);
});
