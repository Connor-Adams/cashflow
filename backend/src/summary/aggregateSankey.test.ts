/**
 * Unit tests for the pure aggregateSankey helper.
 *
 * Covers the AC bullets from issue #224:
 *  - Flow totals match underlying transaction summaries (income, category
 *    netSpend, business spend separation, refund/reward netting).
 *  - Internal transfers handled without double counting (transfer /
 *    investment / dividend txnType all dropped pre-bucketing).
 *  - Empty states clear when data insufficient (no rows or only
 *    money-movement → empty nodes + zero totals).
 *  - Currency filter is respected at the aggregator level.
 *  - Top-N category cap collapses surplus into "Other categories" so the
 *    Sankey stays readable without distorting totals.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateSankey,
  resolveCategoryLabel,
  lookupEdgeTxnIds,
  type SankeyTxnRow,
} from './aggregateSankey';

function row(overrides: Partial<SankeyTxnRow> & { id: number }): SankeyTxnRow {
  return {
    id: overrides.id,
    date: overrides.date ?? '2026-03-15',
    currency: overrides.currency ?? 'CAD',
    finalCategory: overrides.finalCategory ?? null,
    finalBusiness: overrides.finalBusiness ?? false,
    merchantRaw: overrides.merchantRaw ?? 'Test merchant',
    merchantClean: overrides.merchantClean ?? overrides.merchantRaw ?? 'Test merchant',
    amount: overrides.amount ?? '-10.00',
    txnType: overrides.txnType ?? 'purchase',
    accountType: overrides.accountType ?? 'credit',
  };
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
  // AC: internal transfers handled without double counting. They should
  // produce no nodes and no spend/income — the dashboard headline also
  // excludes them, so the Sankey reconciles by also excluding them.
  assert.equal(result.totalIncome, 0);
  assert.equal(result.totalSpend, 0);
  assert.equal(result.transactionCount, 0); // isNonCategorical drops before counting
  assert.deepEqual(result.nodes, []);
  assert.deepEqual(result.links, []);
});

test('aggregateSankey: only an investment-account negative row is dropped', () => {
  // Belt-and-suspenders: brokerage purchase, txnType missing, but account
  // type investment → still dropped (matches dashboard behavior).
  const rows: SankeyTxnRow[] = [
    row({ id: 1, amount: '-2500.00', accountType: 'investment', txnType: null }),
  ];
  const result = aggregateSankey(rows, 'CAD');
  assert.equal(result.totalSpend, 0);
  assert.deepEqual(result.nodes, []);
});

// ---- Currency scoping --------------------------------------------------

test('aggregateSankey: filters by currency', () => {
  const rows: SankeyTxnRow[] = [
    row({ id: 1, amount: '-100.00', currency: 'CAD', finalCategory: 'Groceries' }),
    row({ id: 2, amount: '-50.00', currency: 'USD', finalCategory: 'Groceries' }),
    row({ id: 3, amount: '300.00', currency: 'CAD', txnType: 'income' }),
  ];
  const cadResult = aggregateSankey(rows, 'CAD');
  assert.equal(cadResult.currency, 'CAD');
  assert.equal(cadResult.totalIncome, 300);
  assert.equal(cadResult.totalSpend, 100);
  // Income node + Groceries sink
  assert.equal(cadResult.nodes.length, 2);
  assert.equal(cadResult.nodes[0].name, 'Income');
  assert.equal(cadResult.nodes[1].name, 'Groceries');

  const usdResult = aggregateSankey(rows, 'USD');
  assert.equal(usdResult.totalIncome, 0);
  assert.equal(usdResult.totalSpend, 50);
  // Even with no income, an income source node is rendered so the chart
  // can render the spend-only flow.
  assert.equal(usdResult.nodes[0].name, 'Income');
});

// ---- Category bucketing ------------------------------------------------

test('aggregateSankey: groups spend by finalCategory', () => {
  const rows: SankeyTxnRow[] = [
    row({ id: 1, amount: '-30.00', finalCategory: 'Groceries' }),
    row({ id: 2, amount: '-25.00', finalCategory: 'Groceries' }),
    row({ id: 3, amount: '-100.00', finalCategory: 'Rent' }),
    row({ id: 4, amount: '-20.00', finalCategory: null }),
    // Income source
    row({ id: 5, amount: '2000.00', txnType: 'income' }),
  ];
  const result = aggregateSankey(rows, 'CAD');
  // Spend buckets ranked: Rent 100, Groceries 55, Uncategorized 20.
  assert.equal(result.totalIncome, 2000);
  assert.equal(result.totalSpend, 100 + 55 + 20);
  assert.equal(result.nodes[0].name, 'Income');
  assert.equal(result.nodes[1].name, 'Rent');
  assert.equal(result.nodes[2].name, 'Groceries');
  assert.equal(result.nodes[3].name, 'Uncategorized');
  // Each non-source node has a link from source 0 with the bucket's netSpend.
  assert.equal(result.links.length, 3);
  assert.equal(result.links[0].source, 0);
  assert.equal(result.links[0].target, 1);
  assert.equal(result.links[0].value, 100);
  assert.equal(result.links[1].target, 2);
  assert.equal(result.links[1].value, 55);
  assert.equal(result.links[2].target, 3);
  assert.equal(result.links[2].value, 20);
});

test('aggregateSankey: business spend gets its own sink', () => {
  const rows: SankeyTxnRow[] = [
    row({ id: 1, amount: '-200.00', finalCategory: 'Software', finalBusiness: true }),
    row({ id: 2, amount: '-50.00', finalCategory: 'Software', finalBusiness: false }),
    row({ id: 3, amount: '5000.00', txnType: 'income' }),
  ];
  const result = aggregateSankey(rows, 'CAD');
  // Personal Software spend goes to Software category; business Software
  // goes to "Business spending" — they don't co-mingle so the user can
  // see deductible vs. personal at a glance.
  const labels = result.nodes.map((n) => n.name);
  assert.ok(labels.includes('Software'));
  assert.ok(labels.includes('Business spending'));
  // The business node carries `kind: 'business'`.
  const businessNode = result.nodes.find((n) => n.name === 'Business spending');
  assert.equal(businessNode?.kind, 'business');
  // Totals: 250 spend across the two sinks.
  assert.equal(result.totalSpend, 250);
});

test('aggregateSankey: Uncategorized node carries kind=uncategorized', () => {
  const rows: SankeyTxnRow[] = [
    row({ id: 1, amount: '-15.00', finalCategory: null }),
  ];
  const result = aggregateSankey(rows, 'CAD');
  const node = result.nodes.find((n) => n.name === 'Uncategorized');
  assert.equal(node?.kind, 'uncategorized');
});

// ---- Refund / reward netting -------------------------------------------

test('aggregateSankey: refund row reduces its category netSpend', () => {
  const rows: SankeyTxnRow[] = [
    row({ id: 1, amount: '-100.00', finalCategory: 'Groceries' }),
    // Refund offsets the category spend (same semantics as
    // aggregateDashboard.categoryReports.netSpend).
    row({ id: 2, amount: '25.00', finalCategory: 'Groceries', txnType: 'refund' }),
    row({ id: 3, amount: '1000.00', txnType: 'income' }),
  ];
  const result = aggregateSankey(rows, 'CAD');
  // Net Groceries = 100 - 25 = 75.
  const groceries = result.nodes.find((n) => n.name === 'Groceries');
  assert.ok(groceries);
  const link = result.links.find((l) => l.target === result.nodes.indexOf(groceries));
  assert.equal(link?.value, 75);
  assert.equal(result.totalSpend, 75);
});

test('aggregateSankey: a refund that fully offsets spend drops the category', () => {
  // If netSpend ≤ 0 the category sink would render as a zero-width link,
  // which is visual noise. The aggregator drops it; the txns still live
  // in the underlying data, just not in the Sankey shape.
  const rows: SankeyTxnRow[] = [
    row({ id: 1, amount: '-50.00', finalCategory: 'Returns' }),
    row({ id: 2, amount: '50.00', finalCategory: 'Returns', txnType: 'refund' }),
    row({ id: 3, amount: '500.00', txnType: 'income' }),
  ];
  const result = aggregateSankey(rows, 'CAD');
  const labels = result.nodes.map((n) => n.name);
  assert.ok(!labels.includes('Returns'));
  assert.equal(result.totalSpend, 0);
});

test('aggregateSankey: statement payment positives are excluded from category & income', () => {
  const rows: SankeyTxnRow[] = [
    row({ id: 1, amount: '-200.00', finalCategory: 'Groceries' }),
    // Statement payment landing positive — must not be income, must not
    // net Groceries. Same as classifyPositiveAmount === 'payment'.
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
  // Groceries netSpend stays 200 — payment is filtered.
  const groceries = result.nodes.find((n) => n.name === 'Groceries');
  const link = result.links.find(
    (l) => l.target === result.nodes.indexOf(groceries!),
  );
  assert.equal(link?.value, 200);
  // Income is just the explicit income row, not the payment positive.
  assert.equal(result.totalIncome, 1000);
});

// ---- Income source classification --------------------------------------

test('aggregateSankey: income txnType becomes the Income source', () => {
  const rows: SankeyTxnRow[] = [
    row({ id: 1, amount: '5000.00', txnType: 'income', merchantRaw: 'EMPLOYER' }),
    row({ id: 2, amount: '500.00', txnType: 'income', merchantRaw: 'EMPLOYER' }),
    row({ id: 3, amount: '-200.00', finalCategory: 'Groceries' }),
  ];
  const result = aggregateSankey(rows, 'CAD');
  assert.equal(result.totalIncome, 5500);
  assert.equal(result.nodes[0].name, 'Income');
  assert.equal(result.nodes[0].kind, 'income');
});

// ---- Top-N category cap ------------------------------------------------

test('aggregateSankey: surplus categories collapse into "Other categories"', () => {
  // Build 15 categories descending by spend; cap at 5.
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
  // Expect 6 non-source sinks: top 5 named + one "Other categories".
  const sinkNames = result.nodes.slice(1).map((n) => n.name);
  assert.equal(sinkNames.length, 6);
  assert.ok(sinkNames.includes('Other categories'));
  // Totals reconcile: sum of all 15 negative amounts.
  const expectedTotal = rows.reduce((sum, r) => sum + Math.abs(Number(r.amount)), 0);
  assert.equal(result.totalSpend, expectedTotal);
});

// ---- Edge map / drill-down --------------------------------------------

test('aggregateSankey: edgeMap resolves link → contributing txn IDs', () => {
  const rows: SankeyTxnRow[] = [
    row({ id: 101, amount: '-30.00', finalCategory: 'Groceries' }),
    row({ id: 102, amount: '-25.00', finalCategory: 'Groceries' }),
    row({ id: 201, amount: '-100.00', finalCategory: 'Rent' }),
  ];
  const result = aggregateSankey(rows, 'CAD');
  // Rent sits at index 1 (largest), Groceries at index 2.
  const rentTxns = lookupEdgeTxnIds(result, 0, 1);
  assert.deepEqual(rentTxns, [201]);
  const groceriesTxns = lookupEdgeTxnIds(result, 0, 2);
  assert.deepEqual(groceriesTxns?.sort(), [101, 102]);
  // Unknown edge returns null.
  assert.equal(lookupEdgeTxnIds(result, 0, 99), null);
});

test('aggregateSankey: income-source bucket carries its own edgeMap key', () => {
  const rows: SankeyTxnRow[] = [
    row({ id: 10, amount: '5000.00', txnType: 'income' }),
    row({ id: 11, amount: '500.00', txnType: 'income' }),
    row({ id: 20, amount: '-50.00', finalCategory: 'Groceries' }),
  ];
  const result = aggregateSankey(rows, 'CAD');
  const incomeTxns = result.edgeMap.get('income-source');
  assert.deepEqual(incomeTxns?.sort(), [10, 11]);
});

// ---- Reconciliation with dashboard semantics ---------------------------

test('aggregateSankey: totalSpend reconciles with dashboard netSpend for mixed ledger', () => {
  // Recreates a small dashboard slice: 100 spend, 25 refund net to 75; an
  // investment buy and a transfer that must NOT contribute. Income from
  // employer = 1000. After non-spend filter the dashboard's per-category
  // netSpend for "Groceries" is 75 — the Sankey value should match.
  const rows: SankeyTxnRow[] = [
    row({ id: 1, amount: '-100.00', finalCategory: 'Groceries' }),
    row({ id: 2, amount: '25.00', finalCategory: 'Groceries', txnType: 'refund' }),
    row({ id: 3, amount: '-1500.00', txnType: 'investment', accountType: 'investment' }),
    row({ id: 4, amount: '-500.00', txnType: 'transfer' }),
    row({ id: 5, amount: '500.00', txnType: 'transfer' }),
    row({ id: 6, amount: '1000.00', txnType: 'income' }),
  ];
  const result = aggregateSankey(rows, 'CAD');
  // Single sink: Groceries with net 75.
  assert.equal(result.nodes.length, 2); // Income + Groceries
  assert.equal(result.nodes[1].name, 'Groceries');
  assert.equal(result.totalSpend, 75);
  assert.equal(result.totalIncome, 1000);
});

test('aggregateSankey: links arrays match sink count', () => {
  // Invariant: every non-source node has exactly one inbound link from
  // the Income source (link.source=0). recharts requires this — orphan
  // nodes break rendering.
  const rows: SankeyTxnRow[] = [
    row({ id: 1, amount: '-30.00', finalCategory: 'A' }),
    row({ id: 2, amount: '-30.00', finalCategory: 'B' }),
    row({ id: 3, amount: '-30.00', finalCategory: 'C' }),
    row({ id: 4, amount: '900.00', txnType: 'income' }),
  ];
  const result = aggregateSankey(rows, 'CAD');
  const sinkCount = result.nodes.length - 1; // minus Income source
  assert.equal(result.links.length, sinkCount);
  for (const link of result.links) {
    assert.equal(link.source, 0);
    assert.ok(link.target >= 1 && link.target < result.nodes.length);
    assert.ok(link.value > 0);
  }
});
