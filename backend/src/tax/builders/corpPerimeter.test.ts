import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionCorpPerimeter, type PerimeterTxn } from './corpPerimeter';

// The corp's real revenue chain looks like this in the ledger, one row per hop:
//
//   Wise USD in   "Received money from WANDERCOM"      <- external, unlinked
//   Wise USD out                                       -> linked
//   Wise CAD in   "Converted 5,207.60 USD to 7,125.92" -> linked (FX pair)
//   Wise CAD out  "Sent money to CDG Labs Inc."        -> linked to the arrival
//   RBC in        "Misc Payment CDG LABS INC"          <- link TARGET, no back-pointer
//
// Only the first hop is revenue. `linked_transaction_id` is one-directional,
// so "unlinked" alone is not enough — the arrival leg is unlinked too. A row
// crossed the corp perimeter only if it is NEITHER a link source NOR a link
// target.

function txn(over: Partial<PerimeterTxn> & { id: number; amount: string }): PerimeterTxn {
  return {
    currency: 'CAD',
    date: '2026-03-13',
    txnType: 'transfer',
    linkedTransactionId: null,
    taxTreatmentOverride: null,
    merchant: null,
    ...over,
  };
}

const LEGAL_NAME = 'CDG LABS INC.';

test('counts an external receipt as revenue', () => {
  const rows = [
    txn({ id: 1, amount: '5207.60', currency: 'USD', merchant: 'Received money from WANDERCOM with reference' }),
  ];
  const out = partitionCorpPerimeter(rows, { legalName: LEGAL_NAME, linkTargetIds: new Set() });
  assert.deepEqual(out.revenue.map((r) => r.id), [1]);
  assert.deepEqual(out.warnings, []);
});

test('drops every internal hop of a transfer chain', () => {
  const rows = [
    txn({ id: 1, amount: '5207.60', currency: 'USD', merchant: 'Received money from WANDERCOM with reference' }),
    txn({ id: 2, amount: '-5207.60', currency: 'USD', linkedTransactionId: 3 }), // Wise USD out
    txn({ id: 3, amount: '7125.92', merchant: 'Converted 5,207.60 USD to 7,125.92 CAD', linkedTransactionId: 2 }),
    txn({ id: 4, amount: '-7125.92', merchant: 'Sent money to CDG Labs Inc.', linkedTransactionId: 5 }),
    txn({ id: 5, amount: '7125.92', txnType: 'unknown', merchant: 'Misc Payment CDG LABS INC' }), // arrival: link TARGET
  ];
  const linkTargetIds = new Set([3, 2, 5]);
  const out = partitionCorpPerimeter(rows, { legalName: LEGAL_NAME, linkTargetIds });
  assert.deepEqual(out.revenue.map((r) => r.id), [1], 'only the external receipt is revenue');
  assert.deepEqual(out.expenses.map((r) => r.id), [], 'internal legs are not expenses either');
});

test('warns on an orphaned arrival leg but still counts it', () => {
  // The upstream Wise rows were never imported, so this arrival is a link
  // target of nothing and looks external. Counting it keeps the year from
  // silently understating; the warning says the number is load-bearing.
  const rows = [
    txn({ id: 9, amount: '14891.99', txnType: 'income', merchant: 'Direct deposit from CDG LABS INC' }),
  ];
  const out = partitionCorpPerimeter(rows, { legalName: LEGAL_NAME, linkTargetIds: new Set() });
  assert.deepEqual(out.revenue.map((r) => r.id), [9]);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /#9/);
  assert.match(out.warnings[0], /14891\.99/);
});

test('warns on a perimeter receipt with no counterparty named', () => {
  const rows = [txn({ id: 10, amount: '14500.00', merchant: 'Deposit' })];
  const out = partitionCorpPerimeter(rows, { legalName: LEGAL_NAME, linkTargetIds: new Set() });
  assert.deepEqual(out.revenue.map((r) => r.id), [10]);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /#10/);
});

test('excludes passive investment income from active business income', () => {
  const rows = [
    txn({ id: 11, amount: '77.60', txnType: 'dividend', merchant: 'XEQT cash dividend' }),
    txn({ id: 12, amount: '30.91', txnType: 'interest', merchant: 'Interest received' }),
  ];
  const out = partitionCorpPerimeter(rows, { legalName: LEGAL_NAME, linkTargetIds: new Set() });
  assert.deepEqual(out.revenue, []);
  assert.deepEqual(out.warnings, []);
});

test('excludes rows already consumed as distributions or shareholder loans', () => {
  const rows = [
    txn({ id: 13, amount: '-4100.00', taxTreatmentOverride: 'non_eligible_dividend' }),
    txn({ id: 14, amount: '-5000.00', taxTreatmentOverride: 'salary' }),
    txn({ id: 15, amount: '-5000.00', taxTreatmentOverride: 'employment_income' }),
    txn({ id: 16, amount: '2000.00', taxTreatmentOverride: 'loan_repayment' }),
    txn({ id: 17, amount: '-0.20', taxTreatmentOverride: 'not_income' }),
  ];
  const out = partitionCorpPerimeter(rows, { legalName: LEGAL_NAME, linkTargetIds: new Set() });
  assert.deepEqual(out.revenue, []);
  assert.deepEqual(out.expenses, []);
});

test('counts an external outflow as a deductible expense', () => {
  const rows = [txn({ id: 18, amount: '-6.00', txnType: 'fee', merchant: 'cc fee' })];
  const out = partitionCorpPerimeter(rows, { legalName: LEGAL_NAME, linkTargetIds: new Set() });
  assert.deepEqual(out.expenses.map((r) => r.id), [18]);
});

test('excludes investment purchases from expenses (capital deployment, not a cost)', () => {
  const rows = [txn({ id: 19, amount: '-9999.41', txnType: 'investment', merchant: 'Buy VFV' })];
  const out = partitionCorpPerimeter(rows, { legalName: LEGAL_NAME, linkTargetIds: new Set() });
  assert.deepEqual(out.expenses, []);
});

test('zero-amount rows land in neither bucket', () => {
  const rows = [txn({ id: 20, amount: '0.00' })];
  const out = partitionCorpPerimeter(rows, { legalName: LEGAL_NAME, linkTargetIds: new Set() });
  assert.deepEqual(out.revenue, []);
  assert.deepEqual(out.expenses, []);
});

// An outbound row typed `transfer` is, by definition, half of a pair. Reaching
// the perimeter means its other half was never imported — it is your own money
// moving, not a cost of doing business. Deducting it would understate income,
// so it is dropped and called out. (Inbound transfers are NOT symmetric: Wise
// labels genuine customer payments `transfer`, so those still count.)
test('drops an outbound transfer with no imported pair, and says so', () => {
  const rows = [
    txn({
      id: 21,
      amount: '-10000.00',
      txnType: 'transfer',
      merchant: 'Tax-free money transfer out of the account',
    }),
  ];
  const out = partitionCorpPerimeter(rows, { legalName: LEGAL_NAME, linkTargetIds: new Set() });
  assert.deepEqual(out.expenses, [], 'not a deductible expense');
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /#21/);
  assert.match(out.warnings[0], /not deducted/i);
});

test('an inbound transfer from a named external payer is still revenue', () => {
  const rows = [
    txn({ id: 22, amount: '5207.60', currency: 'USD', txnType: 'transfer', merchant: 'Received money from WANDERCOM' }),
  ];
  const out = partitionCorpPerimeter(rows, { legalName: LEGAL_NAME, linkTargetIds: new Set() });
  assert.deepEqual(out.revenue.map((r) => r.id), [22]);
  assert.deepEqual(out.warnings, []);
});
