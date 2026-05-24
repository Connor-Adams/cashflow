import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreReceiptMatch,
  txnMatchesVendor,
  type CandidatePayment,
} from '../src/import/matchReceiptToTransactions';
import type { ExternalOrder } from '../src/models/ExternalOrder';
import type { Transaction } from '../src/models/Transaction';

function makeTxn(overrides: Partial<Pick<Transaction,
  'amount' | 'date' | 'merchantRaw' | 'merchantClean' | 'notes' | 'sourceReference'>>): Transaction {
  return {
    amount: '0',
    date: '2026-01-01',
    merchantRaw: '',
    merchantClean: '',
    notes: null,
    sourceReference: null,
    ...overrides,
  } as Transaction;
}

function makeOrder(overrides: Partial<Pick<ExternalOrder, 'vendor' | 'orderDate' | 'total' | 'paymentLast4'>>): ExternalOrder {
  return {
    vendor: 'costco',
    orderDate: '2026-01-01',
    total: null,
    paymentLast4: null,
    ...overrides,
  } as ExternalOrder;
}

function pay(amount: number, last4: string | null = null): CandidatePayment {
  return { paymentLast4: last4, amount, tenderId: null };
}

test('txnMatchesVendor matches the right merchant string per vendor', () => {
  const t = makeTxn({ merchantRaw: 'COSTCO WHOLESALE #1168 GUELPH ON', merchantClean: 'Costco' });
  assert.equal(txnMatchesVendor('costco', t), true);
  assert.equal(txnMatchesVendor('amazon', t), false);

  const a = makeTxn({ merchantRaw: 'AMZN MKTP CA', merchantClean: 'Amazon' });
  assert.equal(txnMatchesVendor('amazon', a), true);
  assert.equal(txnMatchesVendor('costco', a), false);
});

test('txnMatchesVendor returns false for an unknown vendor key', () => {
  const t = makeTxn({ merchantRaw: 'COSTCO', merchantClean: 'Costco' });
  assert.equal(txnMatchesVendor('not-a-real-vendor', t), false);
});

test('scoreReceiptMatch: exact amount + same date + merchant match gives high confidence', () => {
  const txn = makeTxn({
    amount: '-947.04',
    date: '2025-12-13',
    merchantRaw: 'COSTCO WHOLESALE #1168 GUELPH ON',
    merchantClean: 'Costco',
  });
  const order = makeOrder({ orderDate: '2025-12-13' });
  const { confidence, matchReason } = scoreReceiptMatch(txn, order, pay(947.04));
  // 50 (amount) + 25 (same-day) + 15 (vendor) = 90
  assert.equal(confidence, 90);
  assert.match(matchReason, /amount within \$0\.50/);
  assert.match(matchReason, /txn 0 day/);
  assert.match(matchReason, /merchant matches costco/);
});

test('scoreReceiptMatch: payment last4 contributes +20 when matching', () => {
  const txn = makeTxn({
    amount: '-1863.72',
    date: '2025-12-26',
    merchantRaw: 'COSTCO WHOLESALE',
    merchantClean: 'Costco',
    notes: 'CARD XXXX-3812',
  });
  const order = makeOrder({ orderDate: '2025-12-26' });
  // 50 (amount) + 25 (date) + 15 (vendor) + 20 (last4) = 110, clamped to 100
  const { confidence } = scoreReceiptMatch(txn, order, pay(1863.72, '3812'));
  assert.equal(confidence, 100);
});

test('scoreReceiptMatch: amount mismatch >$2 penalizes the score', () => {
  const txn = makeTxn({
    amount: '-50.00',
    date: '2025-12-13',
    merchantRaw: 'COSTCO',
    merchantClean: 'Costco',
  });
  const order = makeOrder({ orderDate: '2025-12-13' });
  // -25 (amount) + 25 (date) + 15 (vendor) = 15
  const { confidence, matchReason } = scoreReceiptMatch(txn, order, pay(947.04));
  assert.equal(confidence, 15);
  assert.match(matchReason, /amount mismatch over \$2\.00/);
});

test('scoreReceiptMatch: gap > 10 days penalizes', () => {
  const txn = makeTxn({
    amount: '-100.00',
    date: '2025-12-01',
    merchantRaw: 'COSTCO',
    merchantClean: 'Costco',
  });
  const order = makeOrder({ orderDate: '2025-12-20' });
  // -25 (amount diff) + -15 (date) + 15 (vendor) = -25 → clamped to 0
  const { confidence, matchReason } = scoreReceiptMatch(txn, order, pay(947.04));
  assert.equal(confidence, 0);
  assert.match(matchReason, /date gap over 10 days/);
});

test('scoreReceiptMatch: small negative date gap (POS lag) gets partial credit', () => {
  const txn = makeTxn({
    amount: '-947.04',
    date: '2025-12-12',     // txn posted 1 day BEFORE printed receipt date
    merchantRaw: 'COSTCO',
    merchantClean: 'Costco',
  });
  const order = makeOrder({ orderDate: '2025-12-13' });
  // 50 (amount) + 15 (small negative gap) + 15 (vendor) = 80
  const { confidence } = scoreReceiptMatch(txn, order, pay(947.04));
  assert.equal(confidence, 80);
});

test('scoreReceiptMatch: missing order date short-circuits the date component', () => {
  const txn = makeTxn({
    amount: '-947.04',
    merchantRaw: 'COSTCO',
    merchantClean: 'Costco',
  });
  const order = makeOrder({ orderDate: null });
  // 50 (amount) + 0 (no date) + 15 (vendor) = 65
  const { confidence } = scoreReceiptMatch(txn, order, pay(947.04));
  assert.equal(confidence, 65);
});

test('scoreReceiptMatch: last4 with no match in notes does not boost', () => {
  const txn = makeTxn({
    amount: '-947.04',
    date: '2025-12-13',
    merchantRaw: 'COSTCO',
    merchantClean: 'Costco',
    notes: 'CARD ending 9999',
  });
  const order = makeOrder({ orderDate: '2025-12-13' });
  // 50 + 25 + 15 + 0 (last4 9999 != 3114) = 90
  const { confidence } = scoreReceiptMatch(txn, order, pay(947.04, '3114'));
  assert.equal(confidence, 90);
});
