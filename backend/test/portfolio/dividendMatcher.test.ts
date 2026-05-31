/**
 * Unit tests for the pure dividend-matching heuristic
 * (`backend/src/portfolio/dividendMatcher.ts`, issue #305).
 *
 * Covers the scorer + the "exactly one candidate" auto-match decision
 * (AC #2 / AC #3) without touching the DB. DB-backed behavior
 * (auto-match upserts, list filters, manual match scoping, the unmatched
 * notification) is exercised by the integration suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreDividendCandidate,
  rankDividendCandidates,
  pickAutoMatch,
  varianceFlag,
  type DividendExpectation,
  type CandidateTxn,
} from '../../src/portfolio/dividendMatcher';

const expectation: DividendExpectation = {
  paymentDate: '2026-03-15',
  expectedAmount: 100, // 100 shares × $1.00
  currency: 'USD',
  symbol: 'XYZ',
};

function txn(over: Partial<CandidateTxn>): CandidateTxn {
  return {
    id: 1,
    accountId: 10,
    amount: 100,
    date: '2026-03-15',
    merchant: 'XYZ DIVIDEND',
    currency: 'USD',
    ...over,
  };
}

test('scores an exact same-day credit highly', () => {
  const score = scoreDividendCandidate(expectation, txn({}), {
    dateToleranceDays: 5,
    amountTolerancePct: 2,
  });
  assert.ok(score != null && score > 0, `expected positive score, got ${score}`);
});

test('rejects a debit (negative amount)', () => {
  const score = scoreDividendCandidate(expectation, txn({ amount: -100 }), {
    dateToleranceDays: 5,
    amountTolerancePct: 2,
  });
  assert.equal(score, null);
});

test('rejects amount outside tolerance', () => {
  // expected 100, ±2% = [98,102]; 110 is out.
  const score = scoreDividendCandidate(expectation, txn({ amount: 110 }), {
    dateToleranceDays: 5,
    amountTolerancePct: 2,
  });
  assert.equal(score, null);
});

test('rejects a credit outside the date window', () => {
  const score = scoreDividendCandidate(
    expectation,
    txn({ date: '2026-03-25' }), // +10d, window is ±5
    { dateToleranceDays: 5, amountTolerancePct: 2 },
  );
  assert.equal(score, null);
});

test('ranks closer amount then closer date first', () => {
  const candidates = [
    txn({ id: 1, amount: 101, date: '2026-03-17' }), // off by 1, +2d
    txn({ id: 2, amount: 100, date: '2026-03-16' }), // exact amount, +1d
    txn({ id: 3, amount: 100, date: '2026-03-15' }), // exact amount, same day
  ];
  const ranked = rankDividendCandidates(expectation, candidates, {
    dateToleranceDays: 5,
    amountTolerancePct: 2,
  });
  assert.deepEqual(
    ranked.map((r) => r.id),
    [3, 2, 1],
  );
});

test('pickAutoMatch returns the single candidate when exactly one (AC #2)', () => {
  const candidates = [txn({ id: 7 })];
  const picked = pickAutoMatch(expectation, candidates, {
    dateToleranceDays: 5,
    amountTolerancePct: 2,
  });
  assert.equal(picked?.id, 7);
});

test('pickAutoMatch returns null when zero candidates (AC #3)', () => {
  const picked = pickAutoMatch(expectation, [], {
    dateToleranceDays: 5,
    amountTolerancePct: 2,
  });
  assert.equal(picked, null);
});

test('pickAutoMatch returns null when more than one candidate (AC #3)', () => {
  const candidates = [
    txn({ id: 1, amount: 100, date: '2026-03-15' }),
    txn({ id: 2, amount: 99, date: '2026-03-14' }),
  ];
  const picked = pickAutoMatch(expectation, candidates, {
    dateToleranceDays: 5,
    amountTolerancePct: 2,
  });
  assert.equal(picked, null);
});

test('pickAutoMatch ignores incompatible rows when counting candidates', () => {
  // One real credit + one debit that the scorer rejects → still a single
  // viable candidate, so auto-match should pick it.
  const candidates = [txn({ id: 1, amount: 100 }), txn({ id: 2, amount: -100 })];
  const picked = pickAutoMatch(expectation, candidates, {
    dateToleranceDays: 5,
    amountTolerancePct: 2,
  });
  assert.equal(picked?.id, 1);
});

test('varianceFlag flags > 5% deviation (AC #10)', () => {
  assert.equal(varianceFlag(100, 100), false);
  assert.equal(varianceFlag(100, 104), false); // 4%
  assert.equal(varianceFlag(100, 106), true); // 6%
  assert.equal(varianceFlag(100, 90), true); // -10%
  assert.equal(varianceFlag(0, 0), false); // degenerate, no flag
});
