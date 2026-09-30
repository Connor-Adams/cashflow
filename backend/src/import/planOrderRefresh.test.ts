import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planItemRefresh,
  planTenderRefresh,
  type StoredItem,
  type StoredTender,
} from './planOrderRefresh';
import type { ExtractedReceiptItem, ExtractedReceiptTender } from '../ai/extractReceiptItems';

function parsed(over: Partial<ExtractedReceiptItem> = {}): ExtractedReceiptItem {
  return {
    title: 'DIET COKE',
    quantity: 2,
    unitPrice: 17.99,
    totalPrice: 35.98,
    inferredCategory: null,
    vendorItemId: '85',
    taxable: true,
    ...over,
  };
}

/** Shaped like a Sequelize row: DECIMAL columns come back as strings. */
function stored(over: Partial<StoredItem> = {}): StoredItem {
  return {
    id: 1,
    title: 'DIET COKE',
    quantity: 1,
    unitPrice: '35.9800',
    totalPrice: '35.9800',
    itemNumber: null,
    ...over,
  };
}

test('a differing item count is not refreshed — positional matching would scramble rows', () => {
  const plan = planItemRefresh([parsed(), parsed({ title: 'EXTRA' })], [stored()]);
  assert.equal(plan.skipped, 'count-mismatch');
  assert.deepEqual(plan.updates, []);
});

test('an order already matching the parser produces no updates', () => {
  const plan = planItemRefresh(
    [parsed()],
    [stored({ quantity: 2, unitPrice: '17.9900', totalPrice: '35.9800', itemNumber: '85' })],
  );
  assert.equal(plan.skipped, null);
  assert.deepEqual(plan.updates, []);
});

test('a missing item_number is filled in from the parser', () => {
  const plan = planItemRefresh(
    [parsed()],
    [stored({ quantity: 2, unitPrice: '17.9900', totalPrice: '35.9800', itemNumber: null })],
  );
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].id, 1);
  assert.equal(plan.updates[0].fields.itemNumber, '85');
});

test('a multi-quantity line stored as qty 1 at the extended price is corrected', () => {
  const plan = planItemRefresh([parsed()], [stored()]);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].fields.quantity, 2);
  assert.equal(plan.updates[0].fields.unitPrice, '17.99');
  // the extended price was already right, so it is not re-written
  assert.ok(!('totalPrice' in plan.updates[0].fields));
});

test('decimal strings and numbers compare by value, not by text', () => {
  // 35.9800 === 35.98 — a naive string compare would rewrite every row forever.
  const plan = planItemRefresh(
    [parsed({ quantity: 1, unitPrice: 35.98, totalPrice: 35.98, vendorItemId: null })],
    [stored({ itemNumber: null })],
  );
  assert.deepEqual(plan.updates, []);
});

test('user-owned and AI-owned fields are never part of a refresh', () => {
  const plan = planItemRefresh([parsed({ inferredCategory: 'Groceries' })], [stored()]);
  assert.equal(plan.updates.length, 1);
  const keys = Object.keys(plan.updates[0].fields);
  for (const forbidden of ['inferredCategory', 'confidence', 'displayName', 'businessUsePercent']) {
    assert.ok(!keys.includes(forbidden), `refresh must not touch ${forbidden} (got ${keys.join(', ')})`);
  }
});

test('a corrected title is refreshed', () => {
  const plan = planItemRefresh(
    [parsed({ title: 'MV SS&MV', quantity: 1, unitPrice: 15.98, totalPrice: 15.98, vendorItemId: '2078105' })],
    [stored({ title: '@', quantity: 1, unitPrice: '15.9800', totalPrice: '15.9800', itemNumber: '2078105' })],
  );
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].fields.title, 'MV SS&MV');
});

test('two empty sides is a no-op, not a mismatch', () => {
  const plan = planItemRefresh([], []);
  assert.equal(plan.skipped, null);
  assert.deepEqual(plan.updates, []);
});

// ── tenders ────────────────────────────────────────────────────────────────

function tenderParsed(over: Partial<ExtractedReceiptTender> = {}): ExtractedReceiptTender {
  return { paymentLast4: '3812', network: 'mastercard', amount: 1863.72, ...over };
}
function tenderStored(over: Partial<StoredTender> = {}): StoredTender {
  return { id: 10, paymentLast4: '3812', network: 'mastercard', amount: '1863.7200', ...over };
}

test('a differing tender count is not refreshed', () => {
  const plan = planTenderRefresh([tenderParsed(), tenderParsed()], [tenderStored()]);
  assert.equal(plan.skipped, 'count-mismatch');
  assert.deepEqual(plan.updates, []);
});

test('a tender whose last4 was missing is refreshed', () => {
  const plan = planTenderRefresh([tenderParsed()], [tenderStored({ paymentLast4: null })]);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].fields.paymentLast4, '3812');
});

test('matching tenders produce no updates', () => {
  const plan = planTenderRefresh([tenderParsed()], [tenderStored()]);
  assert.equal(plan.skipped, null);
  assert.deepEqual(plan.updates, []);
});
