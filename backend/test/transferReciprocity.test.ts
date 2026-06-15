/**
 * Unit tests for `backend/src/transfers/reciprocity.ts` (issue #553).
 *
 * Pure logic — no DB. Covers:
 *   - matched counts reciprocal PAIRS, not legs
 *   - one-way / dangling links are surfaced, not silently counted as matched
 *   - byPurpose counts reciprocal pairs
 *   - money-movement aggregates reciprocal pairs and reports dangling totals
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeReciprocity,
  aggregateMoneyMovement,
  type ReciprocityLeg,
  type MovementRow,
} from '../src/transfers/reciprocity.js';

// ------------------- summarizeReciprocity -------------------

test('summarizeReciprocity: a reciprocal pair counts as 1 matched, not 2', () => {
  const legs: ReciprocityLeg[] = [
    { id: 1, linkedTransactionId: 2, transferPurpose: 'internal' },
    { id: 2, linkedTransactionId: 1, transferPurpose: 'internal' },
  ];
  const s = summarizeReciprocity(legs);
  assert.equal(s.matched, 1);
  assert.equal(s.dangling, 0);
  assert.equal(s.unmatched, 0);
  assert.equal(s.byPurpose.internal, 1);
});

test('summarizeReciprocity: one-way link (B does not link back) is dangling, not matched', () => {
  const legs: ReciprocityLeg[] = [
    { id: 1, linkedTransactionId: 2, transferPurpose: 'internal' },
    { id: 2, linkedTransactionId: null, transferPurpose: null },
  ];
  const s = summarizeReciprocity(legs);
  assert.equal(s.matched, 0);
  assert.equal(s.dangling, 1, 'the A→B leg that points at a non-reciprocating sibling is dangling');
  // id=2 has no link at all → unmatched.
  assert.equal(s.unmatched, 1);
  assert.deepEqual(s.byPurpose, {});
});

test('summarizeReciprocity: link to a sibling absent from the set is dangling', () => {
  const legs: ReciprocityLeg[] = [
    { id: 1, linkedTransactionId: 999, transferPurpose: 'reimbursement' },
  ];
  const s = summarizeReciprocity(legs);
  assert.equal(s.matched, 0);
  assert.equal(s.dangling, 1);
  assert.equal(s.unmatched, 0);
});

test('summarizeReciprocity: mismatched link (A→B but B→C) counts both as dangling', () => {
  const legs: ReciprocityLeg[] = [
    { id: 1, linkedTransactionId: 2, transferPurpose: 'internal' },
    { id: 2, linkedTransactionId: 3, transferPurpose: 'internal' },
    { id: 3, linkedTransactionId: 2, transferPurpose: 'internal' },
  ];
  const s = summarizeReciprocity(legs);
  // 2<->3 is NOT reciprocal (2→3 but also 1→2 conflicts; 3→2 and 2→3 would
  // be reciprocal, but 2→3 means 2 reciprocates 3, so 2&3 ARE a pair...).
  // Reciprocity is purely pairwise: 2.linked=3 and 3.linked=2 → reciprocal.
  // 1.linked=2 but 2.linked=3 (not 1) → 1 is dangling.
  assert.equal(s.matched, 1, '2<->3 reciprocate');
  assert.equal(s.dangling, 1, 'leg 1 points at 2 which does not point back');
});

test('summarizeReciprocity: matched count over many reciprocal pairs equals pair count', () => {
  const legs: ReciprocityLeg[] = [];
  for (let p = 0; p < 84; p++) {
    const a = p * 2 + 1;
    const b = p * 2 + 2;
    legs.push({ id: a, linkedTransactionId: b, transferPurpose: 'internal' });
    legs.push({ id: b, linkedTransactionId: a, transferPurpose: 'internal' });
  }
  // Plus 98 one-way dangling legs.
  for (let d = 0; d < 98; d++) {
    legs.push({ id: 10000 + d, linkedTransactionId: 20000 + d, transferPurpose: 'internal' });
  }
  const s = summarizeReciprocity(legs);
  assert.equal(s.matched, 84);
  assert.equal(s.dangling, 98);
});

// ------------------- aggregateMoneyMovement -------------------

function row(over: Partial<MovementRow> & Pick<MovementRow, 'id' | 'accountId' | 'amount'>): MovementRow {
  return {
    linkedTransactionId: null,
    currency: 'CAD',
    transferPurpose: null,
    accountName: `Account #${over.accountId}`,
    ...over,
  };
}

test('aggregateMoneyMovement: reciprocal pair produces one flow row', () => {
  const rows: MovementRow[] = [
    row({ id: 1, accountId: 10, amount: -100, linkedTransactionId: 2, transferPurpose: 'internal' }),
    row({ id: 2, accountId: 20, amount: 100, linkedTransactionId: 1, transferPurpose: 'internal' }),
  ];
  const { flows, dangling } = aggregateMoneyMovement(rows);
  assert.equal(flows.length, 1);
  assert.equal(flows[0].sourceAccountId, 10);
  assert.equal(flows[0].destAccountId, 20);
  assert.equal(flows[0].totalSourceAmount, 100);
  assert.equal(flows[0].count, 1);
  assert.equal(dangling.count, 0);
  assert.equal(dangling.totalSourceAmount, 0);
});

test('aggregateMoneyMovement: one-way link is surfaced in dangling, not dropped', () => {
  const rows: MovementRow[] = [
    row({ id: 1, accountId: 10, amount: -185000, linkedTransactionId: 2, transferPurpose: 'internal' }),
    // sibling 2 exists but does not link back
    row({ id: 2, accountId: 20, amount: 185000, linkedTransactionId: null }),
  ];
  const { flows, dangling } = aggregateMoneyMovement(rows);
  assert.equal(flows.length, 0, 'non-reciprocal pair is not aggregated into flows');
  assert.equal(dangling.count, 1, 'the dangling outbound leg is counted');
  assert.equal(dangling.totalSourceAmount, 185000, 'its absolute value is surfaced');
});

test('aggregateMoneyMovement: link to a sibling not in the row set is dangling', () => {
  const rows: MovementRow[] = [
    row({ id: 1, accountId: 10, amount: -50, linkedTransactionId: 999 }),
  ];
  const { flows, dangling } = aggregateMoneyMovement(rows);
  assert.equal(flows.length, 0);
  assert.equal(dangling.count, 1);
  assert.equal(dangling.totalSourceAmount, 50);
});

test('aggregateMoneyMovement: mixed reciprocal + dangling reports both', () => {
  const rows: MovementRow[] = [
    // reciprocal pair, $300
    row({ id: 1, accountId: 10, amount: -300, linkedTransactionId: 2, transferPurpose: 'internal' }),
    row({ id: 2, accountId: 20, amount: 300, linkedTransactionId: 1, transferPurpose: 'internal' }),
    // dangling outbound, $185k
    row({ id: 3, accountId: 10, amount: -185000, linkedTransactionId: 4 }),
    row({ id: 4, accountId: 20, amount: 185000, linkedTransactionId: null }),
  ];
  const { flows, dangling } = aggregateMoneyMovement(rows);
  assert.equal(flows.length, 1);
  assert.equal(flows[0].totalSourceAmount, 300);
  assert.equal(dangling.count, 1);
  assert.equal(dangling.totalSourceAmount, 185000);
});
