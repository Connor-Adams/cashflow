import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectMatchCandidates,
  MATCH_CONFIDENCE_THRESHOLD,
  FALLBACK_MIN_CONFIDENCE,
} from '../src/amazon/matcher';

type S = { id: number; confidence: number };
const score = (id: number, confidence: number): S => ({ id, confidence });
const ids = (rows: S[]) => rows.map((r) => r.id).sort((a, b) => a - b);

test('threshold constants are sane (floor below threshold)', () => {
  assert.equal(MATCH_CONFIDENCE_THRESHOLD, 70);
  assert.ok(FALLBACK_MIN_CONFIDENCE < MATCH_CONFIDENCE_THRESHOLD);
});

test('returns every candidate at or above the confidence threshold', () => {
  const result = selectMatchCandidates([score(1, 90), score(2, 72), score(3, 70)]);
  assert.deepEqual(ids(result), [1, 2, 3]);
});

test('a strong match suppresses all sub-threshold candidates (no mixing)', () => {
  // The real-world split: one good order + many stale-amount collisions.
  const result = selectMatchCandidates([score(1, 90), score(2, 50), score(3, 50), score(4, 50)]);
  assert.deepEqual(ids(result), [1]);
});

test('ABSTAINS when the best sub-threshold score is a tie (the fan-out bug)', () => {
  // txn 94 in prod: 10 orders all tied at confidence 50 → must produce ZERO links.
  const tied = Array.from({ length: 10 }, (_, i) => score(i + 1, 50));
  assert.deepEqual(selectMatchCandidates(tied), []);
});

test('abstains on a sub-threshold tie even at the floor', () => {
  assert.deepEqual(selectMatchCandidates([score(1, 50), score(2, 50)]), []);
});

test('surfaces the single unambiguous best when it clears the floor', () => {
  const result = selectMatchCandidates([score(1, 65), score(2, 50), score(3, 35)]);
  assert.deepEqual(ids(result), [1]);
});

test('drops a lone best that falls below the fallback floor (merchant-only noise)', () => {
  // confidence 15 = merchant-only / mismatch — never worth an auto-suggestion.
  assert.deepEqual(selectMatchCandidates([score(1, 15)]), []);
  assert.deepEqual(selectMatchCandidates([score(1, 35), score(2, 20)]), []);
});

test('handles empty candidate list', () => {
  assert.deepEqual(selectMatchCandidates([]), []);
});

test('does not mutate the caller-supplied array order', () => {
  const input = [score(1, 50), score(2, 90), score(3, 65)];
  const snapshot = input.map((s) => s.id);
  selectMatchCandidates(input);
  assert.deepEqual(input.map((s) => s.id), snapshot);
});
