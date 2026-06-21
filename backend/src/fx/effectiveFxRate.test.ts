/**
 * Unit tests for the effective-FX-rate derivation.
 *
 * Two derivation strategies:
 *   1. Linked-transfer pair: txn A debits one currency, txn B credits another
 *      currency on the same date; both linked via `linkedTransactionId`.
 *      Effective rate = |B.amount / A.amount| (foreign per unit base).
 *   2. Same-date opposite-sign pair in different currencies on the same
 *      account (heuristic — useful when an explicit link wasn't recorded).
 *
 * Pure function — no DB. Caller wires up the txns and we compute.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveEffectiveRate,
  type RateDerivationTxn,
} from './effectiveFxRate';

const baseTxn: Omit<RateDerivationTxn, 'id' | 'amount' | 'currency'> = {
  accountId: 1,
  date: '2026-01-15',
  linkedTransactionId: null,
};

function t(
  id: number,
  amount: number,
  currency: string,
  opts: Partial<RateDerivationTxn> = {},
): RateDerivationTxn {
  return { ...baseTxn, id, amount: String(amount), currency, ...opts };
}

test('returns null when txn has no candidate pair', () => {
  const result = deriveEffectiveRate(t(1, -100, 'USD'), []);
  assert.equal(result, null);
});

test('returns null for a same-currency transaction', () => {
  const result = deriveEffectiveRate(t(1, -100, 'CAD'), [t(2, 100, 'CAD')]);
  assert.equal(result, null);
});

test('derives rate from explicit linkedTransactionId pair', () => {
  // $100 USD outflow paired with $135 CAD inflow on the same date.
  // Effective rate USD→CAD = 135/100 = 1.35
  const usd = t(1, -100, 'USD', { linkedTransactionId: 2 });
  const cad = t(2, 135, 'CAD');
  const result = deriveEffectiveRate(usd, [cad]);
  assert.ok(result);
  assert.equal(result.source, 'linked_transaction');
  assert.equal(result.fromCurrency, 'USD');
  assert.equal(result.toCurrency, 'CAD');
  assert.ok(Math.abs(result.rate - 1.35) < 0.0001);
  assert.equal(result.counterpartyTxnId, 2);
});

test('derives rate when the linked side is the credit', () => {
  const cad = t(2, 135, 'CAD', { linkedTransactionId: 1 });
  const usd = t(1, -100, 'USD');
  // Asking from the CAD side: rate CAD→USD = 100/135 ≈ 0.74
  const result = deriveEffectiveRate(cad, [usd]);
  assert.ok(result);
  assert.equal(result.fromCurrency, 'CAD');
  assert.equal(result.toCurrency, 'USD');
  assert.ok(Math.abs(result.rate - 100 / 135) < 0.0001);
});

test('derives rate from same-date opposite-sign heuristic without explicit link', () => {
  // Same account, same date, opposite signs, different currencies. Treat
  // them as a paired transfer for rate inference. Lower confidence than an
  // explicit link.
  const usd = t(1, -100, 'USD');
  const cad = t(2, 135, 'CAD');
  const result = deriveEffectiveRate(usd, [cad]);
  assert.ok(result);
  assert.equal(result.source, 'paired_transfer');
  assert.ok(Math.abs(result.rate - 1.35) < 0.0001);
});

test('does not pair when amount signs match', () => {
  // Two debits in different currencies aren't a transfer — they're two
  // independent purchases. Don't fabricate a rate from them.
  const usd = t(1, -100, 'USD');
  const cad = t(2, -135, 'CAD');
  const result = deriveEffectiveRate(usd, [cad]);
  assert.equal(result, null);
});

test('explicit link beats heuristic when both candidates exist', () => {
  const usd = t(1, -100, 'USD', { linkedTransactionId: 3 });
  const cad1 = t(2, 135, 'CAD'); // heuristic candidate
  const cad2 = t(3, 130, 'CAD'); // explicit link counterparty
  const result = deriveEffectiveRate(usd, [cad1, cad2]);
  assert.ok(result);
  assert.equal(result.source, 'linked_transaction');
  assert.equal(result.counterpartyTxnId, 3);
  assert.ok(Math.abs(result.rate - 1.3) < 0.0001);
});

test('does not pair across different accounts', () => {
  const usd = t(1, -100, 'USD', { accountId: 10 });
  const cad = t(2, 135, 'CAD', { accountId: 20 });
  // No same-account match → heuristic returns null.
  const result = deriveEffectiveRate(usd, [cad]);
  assert.equal(result, null);
});

test('does not pair across different dates', () => {
  const usd = t(1, -100, 'USD');
  const cad = t(2, 135, 'CAD', { date: '2026-01-16' });
  const result = deriveEffectiveRate(usd, [cad]);
  assert.equal(result, null);
});

test('skips zero-amount counterparty', () => {
  const usd = t(1, -100, 'USD');
  const zeroCad = t(2, 0, 'CAD');
  const result = deriveEffectiveRate(usd, [zeroCad]);
  assert.equal(result, null);
});

test('heuristic pairing is rejected when implied rate is implausible vs reference', () => {
  // A $100 USD purchase and an unrelated $5000 CAD bill posted the same day on
  // the same account aren't a transfer — the implied rate 50 (vs a real
  // USD→CAD ~1.35) is absurd. With a reference rate the garbage pairing is
  // discarded instead of stored.
  const usd = t(1, -100, 'USD');
  const unrelated = t(2, 5000, 'CAD');
  const result = deriveEffectiveRate(usd, [unrelated], { referenceRate: 1.35 });
  assert.equal(result, null);
});

test('heuristic pairing is kept when implied rate is plausible vs reference', () => {
  const usd = t(1, -100, 'USD');
  const cad = t(2, 135, 'CAD');
  const result = deriveEffectiveRate(usd, [cad], { referenceRate: 1.35 });
  assert.ok(result);
  assert.ok(Math.abs(result.rate - 1.35) < 0.0001);
});

test('explicit link is NOT subjected to the plausibility bound', () => {
  // A recorded link is high-confidence — even an unusual rate is trusted.
  const usd = t(1, -100, 'USD', { linkedTransactionId: 2 });
  const cad = t(2, 5000, 'CAD');
  const result = deriveEffectiveRate(usd, [cad], { referenceRate: 1.35 });
  assert.ok(result);
  assert.equal(result.source, 'linked_transaction');
  assert.ok(Math.abs(result.rate - 50) < 0.0001);
});

test('heuristic pairing is unbounded when no reference rate is supplied', () => {
  // Backward-compatible: callers without a reference rate get the old behavior.
  const usd = t(1, -100, 'USD');
  const unrelated = t(2, 5000, 'CAD');
  const result = deriveEffectiveRate(usd, [unrelated]);
  assert.ok(result);
  assert.ok(Math.abs(result.rate - 50) < 0.0001);
});

test('multiple heuristic candidates: picks the closest absolute match', () => {
  // Among multiple opposite-sign same-date cross-currency txns, pick the
  // one whose CAD amount best matches a "reasonable" rate band — anchor on
  // the largest counterparty (which most banks post as the actual
  // settlement leg, with smaller lines being fees).
  const usd = t(1, -100, 'USD');
  const fee = t(2, 1.5, 'CAD');
  const main = t(3, 135, 'CAD');
  const result = deriveEffectiveRate(usd, [fee, main]);
  assert.ok(result);
  // Larger absolute amount should win.
  assert.equal(result.counterpartyTxnId, 3);
});
