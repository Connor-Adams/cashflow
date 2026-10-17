/**
 * Certainty for a suspected duplicate group.
 *
 * A group shares `(account_id, date, amount)`. That alone is never enough — two
 * $6.00 RBC monthly fees on one day, two equal staking rewards and two genuine
 * $1,000 e-transfers all share it and are distinct events.
 *
 * What makes a group certain is structural invalidity: both rows carry the SAME
 * non-null `linked_transaction_id`. Two legs cannot share one counterpart. Prod
 * has three of these (2863/3315 -> 5499, 2846/3302 -> 5507, 2848/3304 -> 5509).
 *
 * An earlier draft added a second criterion on the `import_batch` period prefix.
 * It was withdrawn before implementation: both `parseStatementFile.ts` and
 * `runImport.ts` build that label from `new Date()`, so `2026-05 <token>` means
 * "imported in May", not "covers May". Two imports in one calendar month share a
 * label, which is the account-14 class exactly — so the withdrawn criterion would
 * have auto-merged the very pairs it could not distinguish.
 *
 * Any manual work on a row disqualifies the group regardless. The row is a
 * judgement Connor made, and a detector does not get to discard it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDuplicateGroup, type DuplicateCandidateRow } from './classifyDuplicateGroup';
import type { TaxTreatmentMaps } from '../tax/builders/resolveTaxTreatment';

const MAPS: TaxTreatmentMaps = {
  catById: new Map([
    [1, { id: 1, parentId: null, taxTreatment: 'medical_expense' }],
    [2, { id: 2, parentId: 1, taxTreatment: 'none' }],
    [9, { id: 9, parentId: null, taxTreatment: 'none' }],
  ]),
  catTreatment: new Map([['Legacy Donations', 'donations']]),
};

function row(over: Partial<DuplicateCandidateRow> = {}): DuplicateCandidateRow {
  return {
    id: 1,
    linkedTransactionId: null,
    businessOverride: false,
    taxTreatmentOverride: null,
    finalCategoryId: null,
    finalCategory: null,
    finalSplitType: 'me',
    receiptCount: 0,
    ...over,
  };
}

function classify(rows: DuplicateCandidateRow[]) {
  return classifyDuplicateGroup(
    { accountId: 14, date: '2026-02-11', amount: '-2000.00', rows },
    { maps: MAPS, defaultSplitType: 'me' },
  );
}

test('a shared non-null linked_transaction_id is certain', () => {
  // Prod pair 971/12178: two -2,000 legs on account 16 pointing at one counterpart.
  const got = classify([
    row({ id: 971, linkedTransactionId: 5499 }),
    row({ id: 12178, linkedTransactionId: 5499 }),
  ]);
  assert.equal(got.verdict, 'certain');
});

test('null links are not a shared link', () => {
  // Two untransferred rows: the recurring $6.00 RBC fee shape. `null === null` is
  // true in JS and would have made every unlinked pair certain.
  const got = classify([row({ id: 1 }), row({ id: 2 })]);
  assert.equal(got.verdict, 'review');
  assert.ok(got.reasons.some((r) => /link/i.test(r)), got.reasons.join('; '));
});

test('different links are not a shared link', () => {
  const got = classify([
    row({ id: 1, linkedTransactionId: 500 }),
    row({ id: 2, linkedTransactionId: 501 }),
  ]);
  assert.equal(got.verdict, 'review');
});

test('one linked row and one unlinked row is review', () => {
  const got = classify([row({ id: 1, linkedTransactionId: 500 }), row({ id: 2 })]);
  assert.equal(got.verdict, 'review');
});

test('a business_override flag disqualifies the group', () => {
  const got = classify([
    row({ id: 1, linkedTransactionId: 5499, businessOverride: true }),
    row({ id: 2, linkedTransactionId: 5499 }),
  ]);
  assert.equal(got.verdict, 'review');
  assert.ok(got.reasons.some((r) => /business/i.test(r)), got.reasons.join('; '));
});

test('a tax treatment override disqualifies the group', () => {
  const got = classify([
    row({ id: 1, linkedTransactionId: 5499, taxTreatmentOverride: 'loan_repayment' }),
    row({ id: 2, linkedTransactionId: 5499 }),
  ]);
  assert.equal(got.verdict, 'review');
});

test('an INHERITED category treatment disqualifies the group, override null', () => {
  // The case the obvious shortcut misses. Category 2's own treatment is 'none' and
  // it inherits medical_expense from its parent; the override is null. Testing the
  // override alone would call this certain and merge away a categorised row.
  const got = classify([
    row({ id: 1, linkedTransactionId: 5499, finalCategoryId: 2 }),
    row({ id: 2, linkedTransactionId: 5499 }),
  ]);
  assert.equal(got.verdict, 'review');
  assert.ok(got.reasons.some((r) => /classif/i.test(r)), got.reasons.join('; '));
});

test('a legacy snake_case finalCategory disqualifies the group', () => {
  const got = classify([
    row({ id: 1, linkedTransactionId: 5499, finalCategory: 'employment_income' }),
    row({ id: 2, linkedTransactionId: 5499 }),
  ]);
  assert.equal(got.verdict, 'review');
});

test('an unclassifying category does not disqualify the group', () => {
  // 'Groceries' resolves to none through every route: still certain.
  const got = classify([
    row({ id: 1, linkedTransactionId: 5499, finalCategoryId: 9, finalCategory: 'Groceries' }),
    row({ id: 2, linkedTransactionId: 5499 }),
  ]);
  assert.equal(got.verdict, 'certain', got.reasons.join('; '));
});

test('a non-default split disqualifies the group', () => {
  const got = classify([
    row({ id: 1, linkedTransactionId: 5499, finalSplitType: 'split' }),
    row({ id: 2, linkedTransactionId: 5499 }),
  ]);
  assert.equal(got.verdict, 'review');
  assert.ok(got.reasons.some((r) => /split/i.test(r)), got.reasons.join('; '));
});

test('an attached receipt disqualifies the group', () => {
  const got = classify([
    row({ id: 1, linkedTransactionId: 5499, receiptCount: 1 }),
    row({ id: 2, linkedTransactionId: 5499 }),
  ]);
  assert.equal(got.verdict, 'review');
  assert.ok(got.reasons.some((r) => /receipt/i.test(r)), got.reasons.join('; '));
});

test('every disqualifying reason is reported, not just the first', () => {
  // Connor works the review queue by hand; a list that stops at the first problem
  // sends him back for a second look.
  const got = classify([
    row({ id: 1, businessOverride: true, finalSplitType: 'split', receiptCount: 2 }),
    row({ id: 2 }),
  ]);
  assert.equal(got.verdict, 'review');
  assert.ok(got.reasons.length >= 4, `expected link + business + split + receipt, got ${got.reasons.join('; ')}`);
});

test('three rows sharing one link are certain, and two are surplus', () => {
  // The duplicated amount is what keeps part 3's dollar estimates honest: N rows
  // at one amount overstate by (N-1) x amount, not by N x amount.
  const got = classify([
    row({ id: 1, linkedTransactionId: 5499 }),
    row({ id: 2, linkedTransactionId: 5499 }),
    row({ id: 3, linkedTransactionId: 5499 }),
  ]);
  assert.equal(got.verdict, 'certain');
  assert.equal(got.surplusCount, 2);
  assert.equal(got.duplicatedAmount, '-4000.00');
});

test('a single row is never a duplicate group', () => {
  assert.throws(() => classify([row()]), /at least two/i);
});

test('businessOverride null counts as not overridden', () => {
  // The column is nullable, and null is the untouched state.
  const got = classify([
    row({ id: 1, linkedTransactionId: 5499, businessOverride: null }),
    row({ id: 2, linkedTransactionId: 5499, businessOverride: null }),
  ]);
  assert.equal(got.verdict, 'certain', got.reasons.join('; '));
});
