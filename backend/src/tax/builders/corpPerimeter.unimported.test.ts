/**
 * `partitionCorpPerimeter` reports outbound transfers whose matching leg was never
 * imported as structured rows, not only as warning strings.
 *
 * Part 3's completeness gate needs exactly this population as a blocker, and the
 * spec names two predicates that look right and are not:
 *
 *   "unlinked" — fails, because `linkedTransactionId` is one-directional, so every
 *   arrival leg in the household is unlinked too.
 *
 *   "neither a link source nor a link target" — fails worse. Inside this file that
 *   condition means *is real revenue or a real expense*: the healthy outcome. It
 *   would flag every third-party corp outgoing, including the nine $6.00 RBC monthly
 *   fees, each with a tax estimate attached.
 *
 * So the gate reads this function's own verdict rather than re-deriving it. The rows
 * were previously `continue`d into nothing, recoverable only by parsing English.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionCorpPerimeter, type PerimeterTxn } from './corpPerimeter';

function txn(over: Partial<PerimeterTxn> & Pick<PerimeterTxn, 'id' | 'amount'>): PerimeterTxn {
  return {
    date: '2026-03-01',
    currency: 'CAD',
    txnType: 'transfer',
    accountType: 'checking',
    linkedTransactionId: null,
    taxTreatmentOverride: null,
    merchantClean: null,
    merchantRaw: null,
    finalCategory: null,
    ...over,
  } as PerimeterTxn;
}

const opts = { legalName: 'CDG Inc.', linkTargetIds: new Set<number>() };

test('an outbound transfer with no matching leg is reported structurally', () => {
  const res = partitionCorpPerimeter([txn({ id: 1, amount: '-15000' })], opts);
  assert.equal(res.unimportedOutboundTransfers.length, 1);
  assert.equal(res.unimportedOutboundTransfers[0].id, 1);
  // Still warns, unchanged — the return already surfaces these to the reader.
  assert.equal(res.warnings.length, 1);
  // And still not deducted as an expense.
  assert.equal(res.expenses.length, 0);
});

test('a third-party outgoing is an expense, not an unimported leg', () => {
  // The $6.00 RBC monthly fee shape. The rejected predicate would flag all nine.
  const res = partitionCorpPerimeter(
    [txn({ id: 2, amount: '-6.00', txnType: 'purchase', merchantClean: 'RBC FEE' })],
    opts,
  );
  assert.equal(res.unimportedOutboundTransfers.length, 0);
  assert.equal(res.expenses.length, 1);
});

test('an outbound transfer explained by a brokerage cash movement is not reported', () => {
  const res = partitionCorpPerimeter([txn({ id: 3, amount: '-7500' })], {
    ...opts,
    internalCashMoves: [{ date: '2026-03-01', amount: '7500', currency: 'CAD' }],
  });
  assert.equal(res.unimportedOutboundTransfers.length, 0);
  assert.equal(res.warnings.length, 0);
});

test('a linked outbound transfer is not reported', () => {
  const res = partitionCorpPerimeter([txn({ id: 4, amount: '-1000', linkedTransactionId: 99 })], opts);
  assert.equal(res.unimportedOutboundTransfers.length, 0);
});

test('an outbound transfer that is a link TARGET is not reported', () => {
  // The one-directional pointer: this row is unlinked but something points at it.
  const res = partitionCorpPerimeter(
    [txn({ id: 5, amount: '-1000' })],
    { ...opts, linkTargetIds: new Set([5]) },
  );
  assert.equal(res.unimportedOutboundTransfers.length, 0);
});

test('a classified outbound transfer is not reported', () => {
  // Connor has already told the system what this is; it is not a gap any more.
  const res = partitionCorpPerimeter(
    [txn({ id: 6, amount: '-1000', taxTreatmentOverride: 'loan_advance' })],
    opts,
  );
  assert.equal(res.unimportedOutboundTransfers.length, 0);
});

test('an INBOUND transfer is not reported — Wise labels customer payments transfer', () => {
  const res = partitionCorpPerimeter([txn({ id: 7, amount: '5000' })], opts);
  assert.equal(res.unimportedOutboundTransfers.length, 0);
  assert.equal(res.revenue.length, 1);
});

test('a securities purchase is not reported', () => {
  const res = partitionCorpPerimeter(
    [txn({ id: 8, amount: '-20000', txnType: 'investment' })],
    opts,
  );
  assert.equal(res.unimportedOutboundTransfers.length, 0);
});

test('a healthy corp ledger reports none', () => {
  // The third condition a blocker must satisfy: it must not fire on a healthy ledger.
  const res = partitionCorpPerimeter([
    txn({ id: 10, amount: '12000', txnType: 'income', merchantClean: 'CLIENT CO' }),
    txn({ id: 11, amount: '-6.00', txnType: 'purchase', merchantClean: 'RBC FEE' }),
    txn({ id: 12, amount: '-450', txnType: 'purchase', merchantClean: 'AWS' }),
  ], opts);
  assert.equal(res.unimportedOutboundTransfers.length, 0);
});
