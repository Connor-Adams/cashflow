import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSplitRequest, computeSplitShares } from './splitShares';

test('even 3-way includes self: equal thirds, self absorbs remainder', () => {
  const r = computeSplitShares('302.71', 'even', [{ contactId: 3 }, { contactId: 7 }], true);
  assert.deepEqual(r.shares, [
    { contactId: 3, amount: '100.9000' },
    { contactId: 7, amount: '100.9000' },
  ]);
  assert.equal(r.selfAmount, '100.9100'); // 302.71 - 201.80
});

test('even exclude self: participants cover full total, residual on last', () => {
  const r = computeSplitShares('100.00', 'even', [{ contactId: 3 }, { contactId: 7 }, { contactId: 9 }], false);
  const sum = r.shares.reduce((a, s) => a + Number(s.amount), 0);
  assert.equal(sum.toFixed(2), '100.00');
  assert.equal(r.selfAmount, '0.0000');
});

test('percent: shares by pct, self gets remainder', () => {
  const r = computeSplitShares('200.00', 'percent', [{ contactId: 3, pct: 25 }, { contactId: 7, pct: 25 }], true);
  assert.deepEqual(r.shares, [
    { contactId: 3, amount: '50.0000' },
    { contactId: 7, amount: '50.0000' },
  ]);
  assert.equal(r.selfAmount, '100.0000');
});

test('percent summing to 100: self is zero, residual on last participant', () => {
  const r = computeSplitShares('100.00', 'percent', [{ contactId: 3, pct: 100 }], true);
  assert.equal(r.shares[0].amount, '100.0000');
  assert.equal(r.selfAmount, '0.0000');
});

test('amount sign is normalised (negative outlay -> positive shares)', () => {
  const r = computeSplitShares(-90, 'even', [{ contactId: 3 }, { contactId: 7 }], true);
  assert.equal(r.shares[0].amount, '30.0000');
});

test('validate: rejects bad method', () => {
  const v = validateSplitRequest({ method: 'wat', participants: [{ contactId: 1 }] });
  assert.equal(v.ok, false);
});

test('validate: rejects empty participants', () => {
  const v = validateSplitRequest({ method: 'even', participants: [] });
  assert.equal(v.ok, false);
});

test('validate: rejects duplicate contactId', () => {
  const v = validateSplitRequest({ method: 'even', participants: [{ contactId: 1 }, { contactId: 1 }] });
  assert.equal(v.ok, false);
});

test('validate: percent sum over 100 rejected', () => {
  const v = validateSplitRequest({ method: 'percent', participants: [{ contactId: 1, pct: 60 }, { contactId: 2, pct: 60 }] });
  assert.equal(v.ok, false);
});

test('validate: defaults includeSelf true, passes a good even body', () => {
  const v = validateSplitRequest({ method: 'even', participants: [{ contactId: 3 }, { contactId: 7 }] });
  assert.ok(v.ok);
  if (v.ok) {
    assert.equal(v.value.includeSelf, true);
    assert.equal(v.value.method, 'even');
  }
});

test('validate: explicit includeSelf false respected', () => {
  const v = validateSplitRequest({ method: 'even', participants: [{ contactId: 3 }], includeSelf: false });
  assert.ok(v.ok && v.value.includeSelf === false);
});
