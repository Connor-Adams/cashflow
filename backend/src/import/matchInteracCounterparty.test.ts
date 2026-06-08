import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchInteracCounterparty } from './matchInteracCounterparty.js';

const email = (amountCents: number, name: string, date: string, ref = 'R') => ({
  name, amountCents, direction: 'sent' as const, ref, emailDate: date, messageId: `m-${name}-${amountCents}`,
});
const txn = (id: number, amount: number, date: string) => ({ id, amountCents: Math.round(Math.abs(amount) * 100), date });

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
