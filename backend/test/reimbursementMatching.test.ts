/**
 * Unit tests for the reimbursement repayment-matching heuristic (issue #216).
 * Pure module — no DB.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreRepaymentCandidate,
  rankRepaymentCandidates,
  MIN_SCORE,
  type ClaimForMatch,
  type CandidateTransaction,
} from '../src/reimbursements/matching';

const claim: ClaimForMatch = {
  amount: '100.00',
  currency: 'CAD',
  outlayDate: '2026-01-10',
  dueDate: '2026-01-24',
};

function cand(over: Partial<CandidateTransaction>): CandidateTransaction {
  return {
    id: 1,
    amount: '100.00',
    currency: 'CAD',
    date: '2026-01-24',
    ...over,
  };
}

test('exact amount + exact due date scores ~1', () => {
  const s = scoreRepaymentCandidate(claim, cand({}));
  assert.ok(s);
  assert.ok(s!.score > 0.99, `expected near-1, got ${s!.score}`);
  assert.equal(s!.amountCloseness, 1);
  assert.equal(s!.dateProximity, 1);
});

test('rejects wrong-sign candidate (outflow, not a repayment)', () => {
  const s = scoreRepaymentCandidate(claim, cand({ amount: '-100.00' }));
  assert.equal(s, null);
});

test('rejects different currency', () => {
  const s = scoreRepaymentCandidate(claim, cand({ currency: 'USD' }));
  assert.equal(s, null);
});

test('rejects candidate dated before the outlay', () => {
  const s = scoreRepaymentCandidate(claim, cand({ date: '2026-01-09' }));
  assert.equal(s, null);
});

test('candidate on the outlay date itself is eligible', () => {
  const s = scoreRepaymentCandidate(claim, cand({ date: '2026-01-10' }));
  assert.ok(s, 'same-day repayment should be eligible');
});

test('amount closeness ramps down with larger delta', () => {
  const close = scoreRepaymentCandidate(claim, cand({ amount: '101.00' })); // 1%
  const mid = scoreRepaymentCandidate(claim, cand({ amount: '110.00' })); // 10%
  const far = scoreRepaymentCandidate(claim, cand({ amount: '130.00' })); // 30% > loose
  assert.ok(close && mid && far);
  assert.equal(close!.amountCloseness, 1, '1% delta still full score');
  assert.ok(mid!.amountCloseness > 0 && mid!.amountCloseness < 1);
  assert.equal(far!.amountCloseness, 0, '30% delta beyond loose → 0');
});

test('date proximity ramps down away from due date', () => {
  const near = scoreRepaymentCandidate(claim, cand({ date: '2026-01-26' })); // +2d
  const mid = scoreRepaymentCandidate(claim, cand({ date: '2026-02-10' })); // ~17d
  assert.ok(near && mid);
  assert.equal(near!.dateProximity, 1, 'within tight window → full');
  assert.ok(mid!.dateProximity > 0 && mid!.dateProximity < 1);
});

test('uses outlay date as reference when no due date', () => {
  const noDue: ClaimForMatch = { ...claim, dueDate: null };
  const onOutlay = scoreRepaymentCandidate(noDue, cand({ date: '2026-01-11' }));
  assert.ok(onOutlay);
  assert.equal(onOutlay!.dateProximity, 1, 'near outlay date → full when no due');
});

test('rankRepaymentCandidates sorts best-first and drops low scores', () => {
  const candidates: CandidateTransaction[] = [
    cand({ id: 10, amount: '100.00', date: '2026-01-24' }), // perfect
    cand({ id: 11, amount: '130.00', date: '2026-06-01' }), // far amount + far date → below MIN
    cand({ id: 12, amount: '102.00', date: '2026-01-28' }), // good
    cand({ id: 13, amount: '-100.00', date: '2026-01-24' }), // wrong sign, dropped
  ];
  const ranked = rankRepaymentCandidates(claim, candidates);
  assert.equal(ranked[0]?.transactionId, 10, 'perfect match first');
  assert.equal(ranked[1]?.transactionId, 12, 'good match second');
  assert.ok(
    ranked.every((r) => r.score >= MIN_SCORE),
    'all results meet MIN_SCORE',
  );
  assert.ok(
    !ranked.some((r) => r.transactionId === 13),
    'wrong-sign candidate excluded',
  );
});

test('limit caps the number of ranked candidates', () => {
  const many: CandidateTransaction[] = Array.from({ length: 10 }, (_, i) =>
    cand({ id: 100 + i, amount: '100.00', date: '2026-01-24' }),
  );
  const ranked = rankRepaymentCandidates(claim, many, 3);
  assert.equal(ranked.length, 3);
});
