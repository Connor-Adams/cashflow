// backend/src/summary/periodInsight.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOwedBack, type OwedBackRow } from './periodInsight';
import { realCostOf, deltaPct } from './periodInsight';
import { topCategoryMovers, type MoverRow } from './periodInsight';

function mrow(o: Partial<MoverRow>): MoverRow {
  return {
    currency: 'CAD',
    amount: '-50.00',
    finalCategory: 'Groceries',
    merchantClean: 'Costco',
    txnType: 'purchase',
    accountType: 'chequing',
    ...o,
  };
}

function row(o: Partial<OwedBackRow>): OwedBackRow {
  return { id: 1, currency: 'CAD', amount: '-100.00', partnerShareAmount: null, ...o };
}

test('computeOwedBack sums partner share for shared spend', () => {
  const out = computeOwedBack(
    [row({ id: 1, amount: '-100.00', partnerShareAmount: '-40.00' })],
    new Map(),
  );
  assert.equal(out.get('CAD')?.partnerShare, 40);
  assert.equal(out.get('CAD')?.reimbursable, 0);
  assert.equal(out.get('CAD')?.owedBack, 40);
});

test('computeOwedBack sums reimbursable claims', () => {
  const out = computeOwedBack(
    [row({ id: 7, amount: '-100.00' })],
    new Map([[7, 60]]),
  );
  assert.equal(out.get('CAD')?.reimbursable, 60);
  assert.equal(out.get('CAD')?.owedBack, 60);
});

test('computeOwedBack dedups: reimbursable wins, partner share ignored on same txn', () => {
  const out = computeOwedBack(
    [row({ id: 9, amount: '-100.00', partnerShareAmount: '-40.00' })],
    new Map([[9, 70]]),
  );
  assert.equal(out.get('CAD')?.reimbursable, 70);
  assert.equal(out.get('CAD')?.partnerShare, 0);
  assert.equal(out.get('CAD')?.owedBack, 70);
});

test('computeOwedBack splits by currency', () => {
  const out = computeOwedBack(
    [
      row({ id: 1, currency: 'CAD', partnerShareAmount: '-10.00' }),
      row({ id: 2, currency: 'USD', partnerShareAmount: '-5.00' }),
    ],
    new Map(),
  );
  assert.equal(out.get('CAD')?.owedBack, 10);
  assert.equal(out.get('USD')?.owedBack, 5);
});

test('realCostOf satisfies the identity netSpend = realCost + owedBack', () => {
  assert.equal(realCostOf(10_000, 4_000), 6_000);
  assert.equal(realCostOf(10_000, 4_000) + 4_000, 10_000);
});

test('deltaPct computes percent change vs baseline', () => {
  assert.equal(deltaPct(120, 100), 20);
  assert.equal(deltaPct(80, 100), -20);
});

test('deltaPct returns null when baseline is zero', () => {
  assert.equal(deltaPct(50, 0), null);
});

test('topCategoryMovers ranks categories by absolute spend delta with driver', () => {
  const current = [
    mrow({ amount: '-300.00', finalCategory: 'Groceries', merchantClean: 'Costco' }),
    mrow({ amount: '-120.00', finalCategory: 'Groceries', merchantClean: 'Costco' }),
    mrow({ amount: '-40.00', finalCategory: 'Dining', merchantClean: 'Sushi' }),
  ];
  const baseline = [
    mrow({ amount: '-100.00', finalCategory: 'Groceries', merchantClean: 'Loblaws' }),
    mrow({ amount: '-220.00', finalCategory: 'Dining', merchantClean: 'Sushi' }),
  ];
  const movers = topCategoryMovers(current, baseline, 'CAD', 2);
  assert.equal(movers[0].category, 'Groceries');
  assert.equal(movers[0].currentRealCost, 420);
  assert.equal(movers[0].baselineRealCost, 100);
  assert.equal(movers[0].deltaAbs, 320);
  assert.equal(movers[0].driver.topMerchant, 'Costco');
  assert.equal(movers[0].driver.txnCount, 2);
  assert.equal(movers[1].category, 'Dining');
  assert.equal(movers[1].deltaAbs, -180);
});

test('topCategoryMovers excludes non-categorical flows and other currencies', () => {
  const current = [
    mrow({ amount: '-500.00', finalCategory: 'Transfers', txnType: 'transfer' }),
    mrow({ amount: '-500.00', currency: 'USD', finalCategory: 'Groceries' }),
    mrow({ amount: '-30.00', finalCategory: 'Groceries' }),
  ];
  const movers = topCategoryMovers(current, [], 'CAD', 5);
  assert.equal(movers.length, 1);
  assert.equal(movers[0].category, 'Groceries');
  assert.equal(movers[0].currentRealCost, 30);
});

test('topCategoryMovers accumulates fractional amounts without float drift', () => {
  // 1000 rows of -0.01 must sum to exactly 10, not 9.999...9 from `+=` drift.
  const current: MoverRow[] = Array.from({ length: 1000 }, () =>
    mrow({ amount: '-0.01', finalCategory: 'Groceries', merchantClean: 'Costco' }),
  );
  const movers = topCategoryMovers(current, [], 'CAD', 5);
  assert.equal(movers[0].category, 'Groceries');
  assert.equal(movers[0].currentRealCost, 10);
  assert.equal(movers[0].deltaAbs, 10);
  assert.equal(movers[0].driver.topMerchant, 'Costco');
  assert.equal(movers[0].driver.txnCount, 1000);
});

test('topCategoryMovers divides baseline totals by baselineDivisor', () => {
  const current = [
    mrow({ amount: '-300.00', finalCategory: 'Groceries', merchantClean: 'Costco' }),
  ];
  const baseline = [
    mrow({ amount: '-200.00', finalCategory: 'Groceries', merchantClean: 'Loblaws' }),
    mrow({ amount: '-200.00', finalCategory: 'Groceries', merchantClean: 'Loblaws' }),
  ];
  // Without divisor: baseline = 400, deltaAbs = -100.
  const undivided = topCategoryMovers(current, baseline, 'CAD', 5);
  assert.equal(undivided[0].baselineRealCost, 400);
  assert.equal(undivided[0].deltaAbs, -100);
  assert.equal(undivided[0].deltaPct, deltaPct(300, 400));
  // With divisor=2: baseline halves to 200, deltaAbs = 100.
  const divided = topCategoryMovers(current, baseline, 'CAD', 5, 2);
  assert.equal(divided[0].baselineRealCost, 200);
  assert.equal(divided[0].deltaAbs, 100);
  assert.equal(divided[0].deltaPct, deltaPct(300, 200));
});
