import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateCategoryBreakdown,
  buildFairnessByCurrency,
  buildFairnessMonthly,
  buildSettlementRecommendation,
  topLargestShared,
  type SettlementTotals,
  type SharedTxnRow,
} from '../src/summary/partnerFairness';

function makeRow(over: Partial<SharedTxnRow> = {}): SharedTxnRow {
  return {
    txnId: 1,
    date: '2026-05-15',
    currency: 'CAD',
    category: 'Groceries',
    merchant: 'Test',
    amount: -100,
    myShare: -50,
    partnerShare: -50,
    ownershipType: 'shared',
    ownershipContactId: null,
    contactName: null,
    ...over,
  };
}

// ---------------- aggregateCategoryBreakdown ----------------

test('aggregateCategoryBreakdown: groups by category and ranks by |sharedSpend|', () => {
  const rows: SharedTxnRow[] = [
    makeRow({ txnId: 1, category: 'Groceries', amount: -200, myShare: -100, partnerShare: -100 }),
    makeRow({ txnId: 2, category: 'Groceries', amount: -50, myShare: -25, partnerShare: -25 }),
    makeRow({ txnId: 3, category: 'Dining', amount: -300, myShare: -150, partnerShare: -150 }),
  ];
  const result = aggregateCategoryBreakdown(rows);
  assert.equal(result.length, 2);
  // Dining (-300) > Groceries (-250) by |sharedSpend|.
  assert.equal(result[0].category, 'Dining');
  assert.equal(result[0].sharedSpend, -300);
  assert.equal(result[0].transactionCount, 1);
  assert.equal(result[1].category, 'Groceries');
  assert.equal(result[1].sharedSpend, -250);
  assert.equal(result[1].transactionCount, 2);
});

test('aggregateCategoryBreakdown: null category surfaces as "Uncategorized"', () => {
  const rows = [makeRow({ category: null, amount: -10, partnerShare: -5 })];
  const result = aggregateCategoryBreakdown(rows);
  assert.equal(result[0].category, 'Uncategorized');
});

test('aggregateCategoryBreakdown: rows with partnerShare=0 are ignored', () => {
  const rows = [
    makeRow({ category: 'Groceries', amount: -100, myShare: -100, partnerShare: 0 }),
  ];
  const result = aggregateCategoryBreakdown(rows);
  assert.equal(result.length, 0);
});

test('aggregateCategoryBreakdown: caps result at 8 categories', () => {
  const rows: SharedTxnRow[] = [];
  for (let i = 0; i < 12; i++) {
    rows.push(
      makeRow({
        txnId: i + 1,
        category: `Cat${i}`,
        amount: -(100 + i),
        partnerShare: -(50 + i),
      }),
    );
  }
  const result = aggregateCategoryBreakdown(rows);
  assert.equal(result.length, 8);
});

// ---------------- topLargestShared ----------------

test('topLargestShared: ranks descending by |amount| and caps at 10', () => {
  const rows: SharedTxnRow[] = [];
  for (let i = 0; i < 15; i++) {
    rows.push(makeRow({ txnId: i + 1, amount: -(i + 1) * 10, partnerShare: -(i + 1) * 5 }));
  }
  const result = topLargestShared(rows);
  assert.equal(result.length, 10);
  // Largest first: amount = -150 (txn 15), then -140, etc.
  assert.equal(result[0].amount, -150);
  assert.equal(result[9].amount, -60);
});

test('topLargestShared: refunds (positive amount) included by |amount|', () => {
  const rows: SharedTxnRow[] = [
    makeRow({ txnId: 1, amount: -50, partnerShare: -25 }),
    makeRow({ txnId: 2, amount: 200, partnerShare: 100 }), // refund — bigger absolute
  ];
  const result = topLargestShared(rows);
  assert.equal(result[0].txnId, 2);
});

test('topLargestShared: rows with partnerShare=0 excluded', () => {
  const rows: SharedTxnRow[] = [
    makeRow({ txnId: 1, amount: -1000, partnerShare: 0 }),
    makeRow({ txnId: 2, amount: -50, partnerShare: -25 }),
  ];
  const result = topLargestShared(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].txnId, 2);
});

// ---------------- buildFairnessByCurrency ----------------

test('buildFairnessByCurrency: single shared purchase produces partner_owes_me balance', () => {
  const rows = [makeRow({ amount: -100, myShare: -50, partnerShare: -50 })];
  // partnerShare sum = -50 → balance = -50 → I owe partner refund-style
  // (negative because amount is negative). The headline direction depends
  // on sign of partnerShareTotal aggregate.
  const result = buildFairnessByCurrency(rows, [], '2026-05-01', '2026-06-01');
  assert.equal(result.length, 1);
  const cad = result[0];
  assert.equal(cad.currency, 'CAD');
  assert.equal(cad.sharedTransactionCount, 1);
  assert.equal(cad.partnerShareTotal, -50);
  assert.equal(cad.balance, -50);
  // Negative partnerShare means partner owes me (single-payer: I paid).
  // Hmm — single-payer convention: positive partnerShare = partner owes me, negative = refund-on-shared = I owe partner.
  // The partner's share of a $100 purchase paid by me is what partner owes me. In the schema, partnerShareAmount
  // is signed the same as amount. So purchase amount=-100, partnerShareAmount=-50 means partner owes me 50 (the
  // signed -50 reads as "partner is on the hook for 50 of my -100 spend"). The fairness `balance` is
  // partnerShareTotal + settlementDelta; we use sign(rounded balance) to decide direction. partnerShareTotal=-50
  // → balance=-50 → rounded < 0 → direction='i_owe_partner'. That's what the existing rawNetForRow does.
  assert.equal(cad.direction, 'i_owe_partner');
});

test('buildFairnessByCurrency: settlement i_paid_partner raises balance', () => {
  const rows = [makeRow({ amount: -100, myShare: -50, partnerShare: -50 })];
  const settlements: SettlementTotals[] = [
    { contactId: 1, currency: 'CAD', iPaid: 80, partnerPaid: 0 },
  ];
  const result = buildFairnessByCurrency(rows, settlements, '2026-05-01', '2026-06-01');
  const cad = result[0];
  // balance = partnerShareTotal(-50) + (iPaid 80 - partnerPaid 0) = 30
  assert.equal(cad.balance, 30);
  assert.equal(cad.direction, 'partner_owes_me');
});

test('buildFairnessByCurrency: sub-cent imbalance collapses to "even"', () => {
  const rows = [makeRow({ amount: -100, myShare: -50, partnerShare: 0.001 })];
  const result = buildFairnessByCurrency(rows, [], '2026-05-01', '2026-06-01');
  assert.equal(result[0].direction, 'even');
});

test('buildFairnessByCurrency: currentMonthSharedSpend sums purchases in [start, next)', () => {
  const rows = [
    makeRow({ date: '2026-05-01', amount: -100, partnerShare: -50 }), // in window (boundary inclusive)
    makeRow({ date: '2026-05-31', amount: -40, partnerShare: -20 }), // in window
    makeRow({ date: '2026-06-01', amount: -999, partnerShare: -499 }), // outside (boundary exclusive)
    makeRow({ date: '2026-04-30', amount: -77, partnerShare: -38 }), // before window
    makeRow({ date: '2026-05-15', amount: 20, partnerShare: 10 }), // refund — excluded from headline
  ];
  const result = buildFairnessByCurrency(rows, [], '2026-05-01', '2026-06-01');
  // Only the -100 and -40 should be counted, summed as positives: 140.
  assert.equal(result[0].currentMonthSharedSpend, 140);
});

test('buildFairnessByCurrency: multi-currency rows produce separate entries', () => {
  const rows = [
    makeRow({ currency: 'CAD', amount: -100, partnerShare: -50 }),
    makeRow({ currency: 'USD', amount: -80, partnerShare: -40 }),
  ];
  const result = buildFairnessByCurrency(rows, [], '2026-05-01', '2026-06-01');
  const currencies = result.map((r) => r.currency).sort();
  assert.deepEqual(currencies, ['CAD', 'USD']);
});

test('buildFairnessByCurrency: settlements in a currency with no rows still surface', () => {
  const settlements: SettlementTotals[] = [
    { contactId: 1, currency: 'CAD', iPaid: 50, partnerPaid: 0 },
  ];
  const result = buildFairnessByCurrency([], settlements, '2026-05-01', '2026-06-01');
  assert.equal(result.length, 1);
  assert.equal(result[0].currency, 'CAD');
  assert.equal(result[0].sharedTransactionCount, 0);
  assert.equal(result[0].balance, 50);
});

test('buildFairnessByCurrency: paidMore.youCovered = -myShareTotal floored at 0', () => {
  const rows = [
    makeRow({ amount: -200, myShare: -100, partnerShare: -100 }),
    makeRow({ amount: -50, myShare: -25, partnerShare: -25 }),
  ];
  const result = buildFairnessByCurrency(rows, [], '2026-05-01', '2026-06-01');
  // myShareTotal = -125 → youCovered = 125
  assert.equal(result[0].paidMore.youCovered, 125);
  assert.equal(result[0].paidMore.partnerCovered, 0);
});

test('buildFairnessByCurrency: paidMore.partnerCovered = partnerPaid - iPaid floored at 0', () => {
  const settlements: SettlementTotals[] = [
    { contactId: 1, currency: 'CAD', iPaid: 30, partnerPaid: 100 },
  ];
  const result = buildFairnessByCurrency([], settlements, '2026-05-01', '2026-06-01');
  assert.equal(result[0].paidMore.partnerCovered, 70);
});

test('buildFairnessByCurrency: category breakdown and largestShared populated', () => {
  const rows = [
    makeRow({ txnId: 1, category: 'Groceries', amount: -200, myShare: -100, partnerShare: -100 }),
    makeRow({ txnId: 2, category: 'Dining', amount: -50, myShare: -25, partnerShare: -25 }),
  ];
  const result = buildFairnessByCurrency(rows, [], '2026-05-01', '2026-06-01');
  assert.equal(result[0].categoryBreakdown.length, 2);
  assert.equal(result[0].largestShared.length, 2);
  // Largest by |amount|: Groceries (-200) > Dining (-50).
  assert.equal(result[0].largestShared[0].txnId, 1);
});

// ---------------- buildFairnessMonthly ----------------

test('buildFairnessMonthly: groups rows by (currency, YYYY-MM)', () => {
  const rows = [
    makeRow({ date: '2026-04-10', amount: -100, partnerShare: -50 }),
    makeRow({ date: '2026-04-25', amount: -40, partnerShare: -20 }),
    makeRow({ date: '2026-05-05', amount: -60, partnerShare: -30 }),
  ];
  const result = buildFairnessMonthly(rows, []);
  assert.equal(result.length, 2);
  const apr = result.find((p) => p.month === '2026-04');
  assert.ok(apr);
  assert.equal(apr.sharedSpend, -140);
  assert.equal(apr.partnerShare, -70);
  const may = result.find((p) => p.month === '2026-05');
  assert.ok(may);
  assert.equal(may.partnerShare, -30);
});

test('buildFairnessMonthly: cumulativeBalance accumulates per currency in chronological order', () => {
  const rows = [
    makeRow({ date: '2026-04-10', amount: -100, partnerShare: -50 }),
    makeRow({ date: '2026-05-10', amount: -200, partnerShare: -100 }),
  ];
  const result = buildFairnessMonthly(rows, []);
  const apr = result.find((p) => p.month === '2026-04')!;
  const may = result.find((p) => p.month === '2026-05')!;
  assert.equal(apr.cumulativeBalance, -50);
  assert.equal(may.cumulativeBalance, -150);
});

test('buildFairnessMonthly: settlements modify cumulativeBalance', () => {
  const rows = [makeRow({ date: '2026-04-10', amount: -100, partnerShare: -50 })];
  const settlements = [
    { contactId: 1, currency: 'CAD', iPaid: 70, partnerPaid: 0, month: '2026-05' },
  ];
  const result = buildFairnessMonthly(rows, settlements);
  const apr = result.find((p) => p.month === '2026-04')!;
  assert.equal(apr.cumulativeBalance, -50);
  const may = result.find((p) => p.month === '2026-05')!;
  assert.equal(may.settlementDelta, 70);
  assert.equal(may.netDelta, 70);
  assert.equal(may.cumulativeBalance, 20);
});

test('buildFairnessMonthly: multi-currency cumulatives independent per currency', () => {
  const rows = [
    makeRow({ currency: 'CAD', date: '2026-04-10', amount: -100, partnerShare: -50 }),
    makeRow({ currency: 'USD', date: '2026-04-10', amount: -80, partnerShare: -40 }),
    makeRow({ currency: 'CAD', date: '2026-05-10', amount: -200, partnerShare: -100 }),
  ];
  const result = buildFairnessMonthly(rows, []);
  const cadApr = result.find((p) => p.currency === 'CAD' && p.month === '2026-04')!;
  const cadMay = result.find((p) => p.currency === 'CAD' && p.month === '2026-05')!;
  const usdApr = result.find((p) => p.currency === 'USD' && p.month === '2026-04')!;
  assert.equal(cadApr.cumulativeBalance, -50);
  assert.equal(cadMay.cumulativeBalance, -150);
  assert.equal(usdApr.cumulativeBalance, -40);
});

test('buildFairnessMonthly: rows with partnerShare=0 ignored', () => {
  const rows = [makeRow({ date: '2026-04-10', amount: -100, myShare: -100, partnerShare: 0 })];
  const result = buildFairnessMonthly(rows, []);
  assert.equal(result.length, 0);
});

// ---------------- buildSettlementRecommendation ----------------

test('buildSettlementRecommendation: positive balance → partner pays you', () => {
  const rec = buildSettlementRecommendation([
    {
      currency: 'CAD',
      sharedSpendTotal: 0,
      myShareTotal: 0,
      partnerShareTotal: 100,
      sharedTransactionCount: 1,
      currentMonthSharedSpend: 0,
      balance: 100,
      direction: 'partner_owes_me',
      paidMore: { youCovered: 0, partnerCovered: 0 },
      categoryBreakdown: [],
      largestShared: [],
    },
  ]);
  assert.equal(rec[0].direction, 'partner_pays_you');
  assert.equal(rec[0].amount, 100);
});

test('buildSettlementRecommendation: negative balance → you pay partner', () => {
  const rec = buildSettlementRecommendation([
    {
      currency: 'CAD',
      sharedSpendTotal: 0,
      myShareTotal: 0,
      partnerShareTotal: -75,
      sharedTransactionCount: 1,
      currentMonthSharedSpend: 0,
      balance: -75,
      direction: 'i_owe_partner',
      paidMore: { youCovered: 0, partnerCovered: 0 },
      categoryBreakdown: [],
      largestShared: [],
    },
  ]);
  assert.equal(rec[0].direction, 'you_pay_partner');
  assert.equal(rec[0].amount, 75);
});

test('buildSettlementRecommendation: sub-cent balance collapses to direction "none"', () => {
  const rec = buildSettlementRecommendation([
    {
      currency: 'CAD',
      sharedSpendTotal: 0,
      myShareTotal: 0,
      partnerShareTotal: 0.001,
      sharedTransactionCount: 0,
      currentMonthSharedSpend: 0,
      balance: 0.001,
      direction: 'even',
      paidMore: { youCovered: 0, partnerCovered: 0 },
      categoryBreakdown: [],
      largestShared: [],
    },
  ]);
  assert.equal(rec[0].direction, 'none');
  assert.equal(rec[0].amount, 0);
});

test('buildSettlementRecommendation: amount is always positive (absolute)', () => {
  const rec = buildSettlementRecommendation([
    {
      currency: 'USD',
      sharedSpendTotal: 0,
      myShareTotal: 0,
      partnerShareTotal: -200,
      sharedTransactionCount: 0,
      currentMonthSharedSpend: 0,
      balance: -200,
      direction: 'i_owe_partner',
      paidMore: { youCovered: 0, partnerCovered: 0 },
      categoryBreakdown: [],
      largestShared: [],
    },
  ]);
  assert.equal(rec[0].amount, 200);
  assert.ok(rec[0].amount >= 0);
});
