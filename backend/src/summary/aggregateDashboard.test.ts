import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateDashboard,
  type SummaryTxnRow,
  type AccountRow,
} from './aggregateDashboard';
import type { ItemAllocationContext } from './loadItemAllocations';

function row(o: Partial<SummaryTxnRow>): SummaryTxnRow {
  return {
    id: 1,
    accountId: 1,
    date: '2026-05-10',
    currency: 'CAD',
    finalCategory: 'Shopping',
    finalBusiness: true,
    finalSplitType: 'me',
    merchantRaw: 'M',
    merchantClean: 'M',
    merchantCanonical: 'M',
    amount: '-100.00',
    reviewFlag: false,
    txnType: 'purchase',
    businessAmount: '0',
    ...o,
  };
}

const accounts = new Map<number, AccountRow>([
  [1, { id: 1, name: 'A', shortCode: null, accountType: 'chequing' }],
]);

// An itemContext with empty maps forces splitTxnByItems down the no-linked-items
// branch, which is the path that reads txn.businessAmount (the prod scenario:
// all business rows have signed business_amount and no order links).
const emptyCtx: ItemAllocationContext = {
  linksByTxn: new Map(),
  ordersById: new Map(),
  itemsByOrder: new Map(),
};

const biz = (out: ReturnType<typeof aggregateDashboard>, b: boolean) =>
  out.netSpendByBusiness.get(`CAD\0${b ? '1' : '0'}`) ?? null;

const metricsOf = (out: ReturnType<typeof aggregateDashboard>, cur = 'CAD') =>
  out.metricsByCurrency.get(cur) ?? null;
const acctOf = (out: ReturnType<typeof aggregateDashboard>, id = 1, cur = 'CAD') =>
  out.accountSummaries.get([cur, String(id)].join('\0')) ?? null;
const merchOf = (out: ReturnType<typeof aggregateDashboard>, m: string, cur = 'CAD') =>
  out.merchantSummaries.get([cur, m].join('\0')) ?? null;

test('no-item business expense (signed business_amount) counts as business SPEND, not a credit', () => {
  const out = aggregateDashboard(
    [row({ amount: '-100.00', businessAmount: '-100.00' })],
    accounts,
    emptyCtx,
  );
  const b = biz(out, true);
  assert.ok(b, 'business bucket should exist');
  assert.equal(b.totalSpend, 100);
  assert.equal(b.totalCredits, 0);
  assert.equal(b.netSpend, 100);
  // personal must NOT be inflated by the flipped half
  assert.equal(biz(out, false), null);
});

test('income (txnType=income) is excluded from the byCategory sumAmount breakdown', () => {
  const out = aggregateDashboard(
    [
      row({ id: 1, amount: '-100.00', businessAmount: '0', finalCategory: 'Groceries' }),
      row({ id: 2, amount: '2500.00', businessAmount: '0', txnType: 'income', finalCategory: null }),
    ],
    accounts,
    emptyCtx,
  );
  const cats = Array.from(out.byCategory.values());
  // A paycheck must not pile into the null/Uncategorized category as a positive.
  assert.equal(
    cats.find((c) => c.category == null),
    undefined,
    'income should not create a byCategory Uncategorized bucket',
  );
  const groceries = cats.find((c) => c.category === 'Groceries');
  assert.ok(groceries);
  assert.equal(groceries.sumAmount, -100);
});

test('business income (txnType=income) lands in income bucket, not netSpend', () => {
  const out = aggregateDashboard(
    [row({ amount: '500.00', txnType: 'income', businessAmount: '500.00' })],
    accounts,
    emptyCtx,
  );
  const b = biz(out, true);
  assert.ok(b);
  assert.equal(b.income, 500);
  assert.equal(b.totalCredits, 0);
  assert.equal(b.totalSpend, 0);
  assert.equal(b.netSpend, 0);
});

test('refund (positive, non-income) nets against spend, not income', () => {
  const out = aggregateDashboard(
    [
      row({ id: 1, amount: '-100.00', businessAmount: '-100.00', txnType: 'purchase' }),
      row({ id: 2, amount: '30.00', businessAmount: '30.00', txnType: 'refund' }),
    ],
    accounts,
    emptyCtx,
  );
  const b = biz(out, true);
  assert.ok(b);
  assert.equal(b.totalSpend, 100);
  assert.equal(b.totalCredits, 30);
  assert.equal(b.netSpend, 70);
  assert.equal(b.income, 0);
});

test('refund exceeding spend yields negative netSpend with zero income', () => {
  const out = aggregateDashboard(
    [
      row({ id: 1, amount: '-50.00', businessAmount: '-50.00', txnType: 'purchase' }),
      row({ id: 2, amount: '80.00', businessAmount: '80.00', txnType: 'refund' }),
    ],
    accounts,
    emptyCtx,
  );
  const b = biz(out, true);
  assert.ok(b);
  assert.equal(b.netSpend, -30);
  assert.equal(b.income, 0);
});

// --- Headline metrics: income must be peeled into its own totalIncome line,
// not folded into totalCredits (refunds). This is the "paychecks show as
// refunds" bug: a direct-deposit (txnType=income) was inflating the refunds
// bucket and deflating netSpend (netSpend = totalSpend - totalCredits).
test('headline income (txnType=income) lands in totalIncome, not totalCredits, excluded from netSpend', () => {
  const out = aggregateDashboard(
    [
      row({ id: 1, amount: '-100.00', txnType: 'purchase' }),
      row({ id: 2, amount: '500.00', txnType: 'income' }),
    ],
    accounts,
    emptyCtx,
  );
  const m = metricsOf(out);
  assert.ok(m);
  assert.equal(m.totalSpend, 100);
  assert.equal(m.totalIncome, 500);
  assert.equal(m.totalCredits, 0, 'income must not inflate the refunds/credits bucket');
  assert.equal(m.netSpend, 100, 'netSpend = spend - credits; income is excluded');
});

test('headline refund (positive, non-income) still nets against spend via totalCredits', () => {
  const out = aggregateDashboard(
    [
      row({ id: 1, amount: '-100.00', txnType: 'purchase' }),
      row({ id: 2, amount: '30.00', txnType: 'refund' }),
    ],
    accounts,
    emptyCtx,
  );
  const m = metricsOf(out);
  assert.ok(m);
  assert.equal(m.totalCredits, 30);
  assert.equal(m.totalIncome, 0);
  assert.equal(m.netSpend, 70);
});

test('headline netSpend reconciles with per-business netSpend sum when income is present', () => {
  const out = aggregateDashboard(
    [
      row({ id: 1, amount: '-100.00', businessAmount: '0', finalBusiness: false, txnType: 'purchase' }),
      row({ id: 2, amount: '500.00', businessAmount: '0', finalBusiness: false, txnType: 'income' }),
    ],
    accounts,
    emptyCtx,
  );
  const m = metricsOf(out);
  assert.ok(m);
  const bizSum = [biz(out, true), biz(out, false)]
    .filter((b): b is NonNullable<typeof b> => b != null)
    .reduce((s, b) => s + b.netSpend, 0);
  assert.equal(bizSum, m.netSpend, 'headline netSpend must equal sum of per-business netSpend');
  assert.equal(m.netSpend, 100);
});

test('income routes to the source account/merchant totalIncome, not totalCredits', () => {
  const out = aggregateDashboard(
    [
      row({
        id: 2,
        amount: '500.00',
        txnType: 'income',
        merchantCanonical: 'CDG LABS',
        merchantClean: 'CDG LABS',
        merchantRaw: 'CDG LABS',
      }),
    ],
    accounts,
    emptyCtx,
  );
  const acct = acctOf(out);
  assert.ok(acct);
  assert.equal(acct.totalIncome, 500);
  assert.equal(acct.totalCredits, 0);
  assert.equal(acct.netSpend, 0);
  const merch = merchOf(out, 'CDG LABS');
  assert.ok(merch);
  assert.equal(merch.totalIncome, 500);
  assert.equal(merch.totalCredits, 0);
});

test('monthly bucket peels income out of totalCredits into totalIncome', () => {
  const out = aggregateDashboard(
    [
      row({ id: 1, amount: '-40.00', txnType: 'purchase', date: '2026-05-03' }),
      row({ id: 2, amount: '500.00', txnType: 'income', date: '2026-05-04' }),
    ],
    accounts,
    emptyCtx,
  );
  const monthly = out.monthlyByCurrency.get('2026-05\0CAD');
  assert.ok(monthly);
  assert.equal(monthly.totalIncome, 500);
  assert.equal(monthly.totalCredits, 0);
  assert.equal(monthly.netSpend, 40, 'monthly netSpend excludes income');
});

// ---- Breakdowns reconcile with the headline (same flow classification) ----

const twoAccounts = new Map<number, AccountRow>([
  [1, { id: 1, name: 'Chequing', shortCode: null, accountType: 'chequing' }],
  [2, { id: 2, name: 'Visa', shortCode: null, accountType: 'credit' }],
]);

/** Σ over every breakdown that claims to decompose the headline netSpend. */
function breakdownTotals(out: ReturnType<typeof aggregateDashboard>, cur = 'CAD') {
  const cats = Array.from(out.byCategory.values()).filter((c) => c.currency === cur);
  const reports = Array.from(out.categoryReports.values()).filter((c) => c.currency === cur);
  const business = Array.from(out.netSpendByBusiness.values()).filter((b) => b.currency === cur);
  return {
    byCategorySpend: -cats.reduce((s, c) => s + c.sumAmount, 0),
    categoryReportsNet: reports.reduce((s, c) => s + c.netSpend, 0),
    businessNet: business.reduce((s, b) => s + b.netSpend, 0),
    categories: cats.map((c) => c.category),
    reportCategories: reports.map((c) => c.category),
  };
}

test('negative chequing-side card-payment leg (txnType=payment) is excluded from every breakdown', () => {
  const out = aggregateDashboard(
    [
      row({ id: 1, accountId: 2, amount: '-200.00', finalCategory: 'Groceries', finalBusiness: false }),
      // Chequing side of paying the card off.
      row({
        id: 2,
        accountId: 1,
        amount: '-200.00',
        txnType: 'payment',
        finalCategory: 'Credit Card Payment',
        finalBusiness: false,
        merchantRaw: 'VISA PAYMENT',
        merchantClean: 'VISA PAYMENT',
      }),
      // Card side of the same payment.
      row({
        id: 3,
        accountId: 2,
        amount: '200.00',
        txnType: 'payment',
        finalCategory: 'Credit Card Payment',
        finalBusiness: false,
        merchantRaw: 'PAYMENT THANK YOU',
        merchantClean: 'PAYMENT THANK YOU',
      }),
    ],
    twoAccounts,
    emptyCtx,
  );
  assert.equal(metricsOf(out)?.netSpend, 200);
  const t = breakdownTotals(out);
  assert.deepEqual(t.categories, ['Groceries']);
  assert.deepEqual(t.reportCategories, ['Groceries']);
  assert.equal(t.byCategorySpend, 200);
  assert.equal(t.categoryReportsNet, 200);
  assert.equal(t.businessNet, 200);
});

test('positive row the headline classifies as skip (unknown deposit) is excluded from every breakdown', () => {
  const out = aggregateDashboard(
    [
      row({ id: 1, amount: '-200.00', finalCategory: 'Groceries', finalBusiness: false }),
      row({
        id: 2,
        amount: '150.00',
        txnType: 'unknown',
        finalCategory: null,
        finalBusiness: false,
        merchantRaw: 'DEPOSIT FROM MOM',
        merchantClean: 'DEPOSIT FROM MOM',
      }),
    ],
    accounts,
    emptyCtx,
  );
  assert.equal(metricsOf(out)?.netSpend, 200);
  const t = breakdownTotals(out);
  assert.deepEqual(t.categories, ['Groceries']);
  assert.equal(t.byCategorySpend, 200);
  assert.equal(t.categoryReportsNet, 200);
  assert.equal(t.businessNet, 200);
});

test('refund credits still net against category breakdowns and reconcile with headline', () => {
  const out = aggregateDashboard(
    [
      row({ id: 1, amount: '-200.00', finalCategory: 'Groceries', finalBusiness: false }),
      row({ id: 2, amount: '50.00', txnType: 'refund', finalCategory: 'Groceries', finalBusiness: false }),
    ],
    accounts,
    emptyCtx,
  );
  assert.equal(metricsOf(out)?.netSpend, 150);
  const t = breakdownTotals(out);
  assert.equal(t.byCategorySpend, 150);
  assert.equal(t.categoryReportsNet, 150);
  assert.equal(t.businessNet, 150);
});
