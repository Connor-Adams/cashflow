/**
 * Unit tests for the pure helpers in routes/largePurchaseReview.ts. Exercises:
 *  - validateLargePurchaseReviewPatch — valid fields, invalid statuses, boolean coercion
 *  - serializeLargePurchaseReview — null and populated metadata
 *  - rowToLargePurchaseView — view shape
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateLargePurchaseReviewPatch,
  serializeLargePurchaseReview,
  rowToLargePurchaseView,
} from '../src/routes/largePurchaseReview';
import type { TransactionLargePurchaseReview } from '../src/models/TransactionLargePurchaseReview';

// ----- validateLargePurchaseReviewPatch ----------------------------------------

test('accepts empty patch body', () => {
  const result = validateLargePurchaseReviewPatch({});
  assert.ok(result.ok);
  assert.deepEqual(result.value, {});
});

test('accepts all valid status values', () => {
  for (const status of ['pending', 'reviewed', 'dismissed'] as const) {
    const result = validateLargePurchaseReviewPatch({ status });
    assert.ok(result.ok, `should accept status=${status}`);
    assert.equal(result.value.status, status);
  }
});

test('rejects unknown status', () => {
  const result = validateLargePurchaseReviewPatch({ status: 'approved' });
  assert.ok(!result.ok);
  assert.equal(result.status, 400);
  assert.ok(result.error.includes('status'));
});

test('accepts boolean checklist fields as true/false', () => {
  const result = validateLargePurchaseReviewPatch({
    categoryConfirmed: true,
    businessRelevant: false,
    receiptConfirmed: true,
    warrantyTracked: false,
    reimbursementTracked: true,
  });
  assert.ok(result.ok);
  assert.equal(result.value.categoryConfirmed, true);
  assert.equal(result.value.businessRelevant, false);
  assert.equal(result.value.receiptConfirmed, true);
  assert.equal(result.value.warrantyTracked, false);
  assert.equal(result.value.reimbursementTracked, true);
});

test('accepts boolean checklist fields as null (clearing)', () => {
  const result = validateLargePurchaseReviewPatch({
    categoryConfirmed: null,
    businessRelevant: null,
  });
  assert.ok(result.ok);
  assert.equal(result.value.categoryConfirmed, null);
  assert.equal(result.value.businessRelevant, null);
});

test('accepts boolean coercion from string "true"/"false"', () => {
  const result = validateLargePurchaseReviewPatch({
    categoryConfirmed: 'true',
    businessRelevant: 'false',
  });
  assert.ok(result.ok);
  assert.equal(result.value.categoryConfirmed, true);
  assert.equal(result.value.businessRelevant, false);
});

test('rejects invalid boolean value for checklist field', () => {
  const result = validateLargePurchaseReviewPatch({ categoryConfirmed: 'yes' });
  assert.ok(!result.ok);
  assert.equal(result.status, 400);
  assert.ok(result.error.includes('categoryConfirmed'));
});

test('accepts valid ISO date for reviewedAt', () => {
  const result = validateLargePurchaseReviewPatch({ reviewedAt: '2026-06-01' });
  assert.ok(result.ok);
  assert.equal(result.value.reviewedAt, '2026-06-01');
});

test('accepts null for reviewedAt', () => {
  const result = validateLargePurchaseReviewPatch({ reviewedAt: null });
  assert.ok(result.ok);
  assert.equal(result.value.reviewedAt, null);
});

test('rejects malformed reviewedAt', () => {
  const result = validateLargePurchaseReviewPatch({ reviewedAt: '2026/06/01' });
  assert.ok(!result.ok);
  assert.equal(result.status, 400);
  assert.ok(result.error.includes('reviewedAt'));
});

test('accepts notes as string (truncated at 4000 chars)', () => {
  const longNote = 'x'.repeat(5000);
  const result = validateLargePurchaseReviewPatch({ notes: longNote });
  assert.ok(result.ok);
  assert.equal(result.value.notes?.length, 4000);
});

test('accepts notes as null', () => {
  const result = validateLargePurchaseReviewPatch({ notes: null });
  assert.ok(result.ok);
  assert.equal(result.value.notes, null);
});

// ----- serializeLargePurchaseReview --------------------------------------------

test('serializeLargePurchaseReview returns default shape for null input', () => {
  const view = serializeLargePurchaseReview(null);
  assert.equal(view.transactionId, null);
  assert.equal(view.status, 'pending');
  assert.equal(view.categoryConfirmed, null);
  assert.equal(view.businessRelevant, null);
  assert.equal(view.receiptConfirmed, null);
  assert.equal(view.warrantyTracked, null);
  assert.equal(view.reimbursementTracked, null);
  assert.equal(view.notes, null);
  assert.equal(view.reviewedAt, null);
});

test('serializeLargePurchaseReview maps all fields from populated model', () => {
  const fakeReview = {
    transactionId: 42,
    status: 'reviewed',
    categoryConfirmed: true,
    businessRelevant: false,
    receiptConfirmed: true,
    warrantyTracked: null,
    reimbursementTracked: null,
    notes: 'MacBook Pro — needed for work',
    reviewedAt: '2026-06-15',
  } as unknown as TransactionLargePurchaseReview;

  const view = serializeLargePurchaseReview(fakeReview);
  assert.equal(view.transactionId, 42);
  assert.equal(view.status, 'reviewed');
  assert.equal(view.categoryConfirmed, true);
  assert.equal(view.businessRelevant, false);
  assert.equal(view.receiptConfirmed, true);
  assert.equal(view.warrantyTracked, null);
  assert.equal(view.reimbursementTracked, null);
  assert.equal(view.notes, 'MacBook Pro — needed for work');
  assert.equal(view.reviewedAt, '2026-06-15');
});

// ----- rowToLargePurchaseView --------------------------------------------------

test('rowToLargePurchaseView produces expected shape', () => {
  const row = {
    id: 10,
    date: '2026-06-01',
    merchantClean: 'Apple Store',
    amount: '-1999.9900',
    currency: 'CAD',
    finalCategory: 'Electronics',
    account: { id: 1, name: 'TD Visa' },
    largePurchaseReview: {
      transactionId: 10,
      status: 'pending',
      categoryConfirmed: null,
      businessRelevant: null,
      receiptConfirmed: null,
      warrantyTracked: null,
      reimbursementTracked: null,
      notes: null,
      reviewedAt: null,
    } as unknown as TransactionLargePurchaseReview,
  };

  const view = rowToLargePurchaseView(row);
  assert.equal(view.id, 10);
  assert.equal(view.date, '2026-06-01');
  assert.equal(view.merchant, 'Apple Store');
  assert.equal(view.amount, '-1999.9900');
  assert.equal(view.currency, 'CAD');
  assert.equal(view.finalCategory, 'Electronics');
  assert.equal(view.accountName, 'TD Visa');
  assert.equal(view.review.status, 'pending');
});

test('rowToLargePurchaseView handles missing review (null review)', () => {
  const row = {
    id: 20,
    date: '2026-06-01',
    merchantClean: 'Best Buy',
    amount: '-800.0000',
    currency: 'CAD',
    finalCategory: null,
    account: null,
    largePurchaseReview: null,
  };

  const view = rowToLargePurchaseView(row);
  assert.equal(view.id, 20);
  assert.equal(view.accountName, null);
  assert.equal(view.review.status, 'pending');
  assert.equal(view.review.transactionId, null);
});
