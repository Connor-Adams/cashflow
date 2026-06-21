import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchInteracCounterparty } from './matchInteracCounterparty.js';

const email = (
  amountCents: number,
  name: string,
  date: string,
  ref = 'R',
  direction: 'sent' | 'received' = 'sent',
) => ({
  name, amountCents, direction, ref, emailDate: date, messageId: `m-${name}-${amountCents}-${direction}`,
});
// Direction mirrors the txn sign the orchestrator derives: negative = sent, positive = received.
const txn = (id: number, amount: number, date: string) => ({
  id,
  amountCents: Math.round(Math.abs(amount) * 100),
  date,
  direction: amount < 0 ? ('sent' as const) : ('received' as const),
});

test('unique exact amount within 3 days -> auto', () => {
  const r = matchInteracCounterparty(
    [email(500000, 'Stephen Masseur', '2025-06-04')],
    [txn(1, -5000, '2025-06-04')],
    'Connor Adams',
  );
  assert.equal(r.auto.length, 1);
  assert.equal(r.auto[0].txnId, 1);
  assert.equal(r.auto[0].name, 'Stephen Masseur');
  assert.equal(r.auto[0].isSelf, false);
  assert.equal(r.review.length, 0);
});

test('two txns same amount -> review (collision)', () => {
  const r = matchInteracCounterparty(
    [email(500000, 'Stephen Masseur', '2025-06-04'), email(500000, 'Finnska Inc.', '2025-06-05')],
    [txn(1, -5000, '2025-06-04'), txn(2, -5000, '2025-06-05')],
    'Connor Adams',
  );
  assert.equal(r.auto.length, 0);
  assert.ok(r.review.length >= 1);
});

test('outside 3-day window -> no match', () => {
  const r = matchInteracCounterparty([email(500000, 'X', '2025-06-01')], [txn(1, -5000, '2025-06-10')], 'Connor Adams');
  assert.equal(r.auto.length + r.review.length, 0);
});

test('self name -> isSelf true', () => {
  const r = matchInteracCounterparty([email(100000, 'Connor Adams', '2025-07-15')], [txn(1, 1000, '2025-07-15')], 'Connor Adams');
  assert.equal(r.auto.length, 1);
  assert.equal(r.auto[0].isSelf, true);
});

test('received email does NOT match a sent (negative) txn', () => {
  // Household sent $50; the only same-amount email is "received $50 from Bob".
  // Direction disagrees with the txn sign, so Bob must not be attached.
  const r = matchInteracCounterparty(
    [email(5000, 'Bob', '2025-06-04', 'R', 'received')],
    [txn(1, -50, '2025-06-04')],
    'Connor Adams',
  );
  assert.equal(r.auto.length + r.review.length, 0, 'direction mismatch → no match at all');
});

test('sent email does NOT match a received (positive) txn from a non-self sender', () => {
  const r = matchInteracCounterparty(
    [email(5000, 'Bob', '2025-06-04', 'R', 'sent')],
    [txn(1, 50, '2025-06-04')],
    'Connor Adams',
  );
  assert.equal(r.auto.length + r.review.length, 0);
});

test('received email matches a positive txn -> auto', () => {
  const r = matchInteracCounterparty(
    [email(5000, 'Bob', '2025-06-04', 'R', 'received')],
    [txn(1, 50, '2025-06-04')],
    'Connor Adams',
  );
  assert.equal(r.auto.length, 1);
  assert.equal(r.auto[0].name, 'Bob');
});

test('direction disambiguates two same-amount txns of opposite sign', () => {
  // One sent email; a -$50 (sent) and a +$50 (received) txn in window. Only the
  // negative txn is direction-compatible, so the match is unambiguous → auto.
  const r = matchInteracCounterparty(
    [email(5000, 'Bob', '2025-06-04', 'R', 'sent')],
    [txn(1, -50, '2025-06-04'), txn(2, 50, '2025-06-04')],
    'Connor Adams',
  );
  assert.equal(r.auto.length, 1, 'opposite-sign txn must not count as a collision');
  assert.equal(r.auto[0].txnId, 1);
  assert.equal(r.review.length, 0);
});

test('self-named email may match either direction (both legs of a self-transfer)', () => {
  // A self e-transfer produces one 'sent' email but BOTH a negative (sending
  // account) and positive (receiving account) txn can carry it.
  const r = matchInteracCounterparty(
    [email(100000, 'Connor Adams', '2025-07-15', 'R', 'sent')],
    [txn(1, 1000, '2025-07-15')],
    'Connor Adams',
  );
  assert.equal(r.auto.length, 1);
  assert.equal(r.auto[0].isSelf, true);
});

test('two same-amount txns FAR apart each auto-match their own email', () => {
  const r = matchInteracCounterparty(
    [email(500000, 'Finnska Inc.', '2025-06-04'), email(500000, 'Finnska Inc.', '2025-07-04')],
    [txn(1, -5000, '2025-06-04'), txn(2, -5000, '2025-07-04')],
    'Connor Adams',
  );
  assert.equal(r.auto.length, 2, 'temporally-separated same-amount txns are NOT a collision');
  assert.equal(r.review.length, 0);
  assert.deepEqual(r.auto.map((m) => m.txnId).sort(), [1, 2]);
});
