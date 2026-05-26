import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePlannedEventInput,
  validatePlannedEventPatch,
} from '../src/routes/plannedEvents';

// ---- validatePlannedEventInput ------------------------------------------

test('validatePlannedEventInput: accepts a minimal valid expense', () => {
  const result = validatePlannedEventInput({
    type: 'expense',
    name: 'Rent',
    amount: 1500,
    currency: 'CAD',
    expectedDate: '2026-06-01',
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.type, 'expense');
    assert.equal(result.value.name, 'Rent');
    assert.equal(result.value.amount, '1500.0000');
    assert.equal(result.value.currency, 'CAD');
    assert.equal(result.value.expectedDate, '2026-06-01');
    assert.equal(result.value.source, 'manual');
    assert.equal(result.value.status, 'planned');
    assert.equal(result.value.accountId, null);
    assert.equal(result.value.recurrenceRule, null);
    assert.equal(result.value.linkedTransactionId, null);
    assert.equal(result.value.notes, null);
  }
});

test('validatePlannedEventInput: rejects unknown type', () => {
  const result = validatePlannedEventInput({
    type: 'gift',
    name: 'birthday',
    amount: 50,
    currency: 'CAD',
    expectedDate: '2026-06-01',
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.match(result.error, /type must be one of/);
  }
});

test('validatePlannedEventInput: accepts all six type variants', () => {
  const types = [
    'income',
    'expense',
    'transfer',
    'settlement',
    'debt_payment',
    'savings',
  ] as const;
  for (const type of types) {
    const result = validatePlannedEventInput({
      type,
      name: `event-${type}`,
      amount: 10,
      currency: 'USD',
      expectedDate: '2026-06-15',
    });
    assert.equal(result.ok, true, `failed for type=${type}`);
  }
});

test('validatePlannedEventInput: requires name', () => {
  const result = validatePlannedEventInput({
    type: 'expense',
    name: '   ',
    amount: 10,
    currency: 'CAD',
    expectedDate: '2026-06-01',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /name is required/);
});

test('validatePlannedEventInput: rejects negative amount', () => {
  const result = validatePlannedEventInput({
    type: 'expense',
    name: 'Rent',
    amount: -100,
    currency: 'CAD',
    expectedDate: '2026-06-01',
  });
  assert.equal(result.ok, false);
});

test('validatePlannedEventInput: accepts zero amount (placeholder events)', () => {
  // Zero is allowed — e.g. a "TBD" planning placeholder. Sign comes from
  // the `type` field, not the amount sign.
  const result = validatePlannedEventInput({
    type: 'income',
    name: 'Year-end bonus (TBD)',
    amount: 0,
    currency: 'CAD',
    expectedDate: '2026-12-31',
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.amount, '0.0000');
});

test('validatePlannedEventInput: rejects non-numeric amount', () => {
  const result = validatePlannedEventInput({
    type: 'expense',
    name: 'Rent',
    amount: 'big',
    currency: 'CAD',
    expectedDate: '2026-06-01',
  });
  assert.equal(result.ok, false);
});

test('validatePlannedEventInput: rejects bad currency', () => {
  const result = validatePlannedEventInput({
    type: 'expense',
    name: 'Rent',
    amount: 100,
    currency: 'CA',
    expectedDate: '2026-06-01',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /3-letter ISO code/);
});

test('validatePlannedEventInput: uppercases currency', () => {
  const result = validatePlannedEventInput({
    type: 'expense',
    name: 'Rent',
    amount: 100,
    currency: 'cad',
    expectedDate: '2026-06-01',
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.currency, 'CAD');
});

test('validatePlannedEventInput: rejects bad date format', () => {
  const result = validatePlannedEventInput({
    type: 'expense',
    name: 'Rent',
    amount: 100,
    currency: 'CAD',
    expectedDate: '06/01/2026',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /YYYY-MM-DD/);
});

test('validatePlannedEventInput: requires expectedDate', () => {
  const result = validatePlannedEventInput({
    type: 'expense',
    name: 'Rent',
    amount: 100,
    currency: 'CAD',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /expectedDate is required/);
});

test('validatePlannedEventInput: rejects invalid source', () => {
  const result = validatePlannedEventInput({
    type: 'expense',
    name: 'Rent',
    amount: 100,
    currency: 'CAD',
    expectedDate: '2026-06-01',
    source: 'mystery',
  });
  assert.equal(result.ok, false);
});

test('validatePlannedEventInput: rejects invalid status', () => {
  const result = validatePlannedEventInput({
    type: 'expense',
    name: 'Rent',
    amount: 100,
    currency: 'CAD',
    expectedDate: '2026-06-01',
    status: 'maybe',
  });
  assert.equal(result.ok, false);
});

test('validatePlannedEventInput: passes through recurrenceRule', () => {
  const result = validatePlannedEventInput({
    type: 'expense',
    name: 'Rent',
    amount: 1500,
    currency: 'CAD',
    expectedDate: '2026-06-01',
    recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=1',
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.recurrenceRule, 'FREQ=MONTHLY;BYMONTHDAY=1');
  }
});

test('validatePlannedEventInput: blank recurrenceRule becomes null', () => {
  const result = validatePlannedEventInput({
    type: 'expense',
    name: 'Rent',
    amount: 1500,
    currency: 'CAD',
    expectedDate: '2026-06-01',
    recurrenceRule: '   ',
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.recurrenceRule, null);
});

test('validatePlannedEventInput: rejects non-integer accountId', () => {
  const result = validatePlannedEventInput({
    type: 'expense',
    name: 'Rent',
    amount: 1500,
    currency: 'CAD',
    expectedDate: '2026-06-01',
    accountId: 'abc',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /accountId/);
});

test('validatePlannedEventInput: rejects negative accountId', () => {
  const result = validatePlannedEventInput({
    type: 'expense',
    name: 'Rent',
    amount: 1500,
    currency: 'CAD',
    expectedDate: '2026-06-01',
    accountId: -3,
  });
  assert.equal(result.ok, false);
});

// ---- validatePlannedEventPatch ------------------------------------------

test('validatePlannedEventPatch: empty patch is valid', () => {
  const result = validatePlannedEventPatch({});
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, {});
});

test('validatePlannedEventPatch: accepts partial field update', () => {
  const result = validatePlannedEventPatch({ status: 'posted' });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.status, 'posted');
    assert.equal(result.value.amount, undefined);
  }
});

test('validatePlannedEventPatch: rejects empty name', () => {
  const result = validatePlannedEventPatch({ name: '   ' });
  assert.equal(result.ok, false);
});

test('validatePlannedEventPatch: rejects bad amount', () => {
  const result = validatePlannedEventPatch({ amount: -1 });
  assert.equal(result.ok, false);
});

test('validatePlannedEventPatch: allows clearing accountId via null', () => {
  const result = validatePlannedEventPatch({ accountId: null });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.accountId, null);
});

test('validatePlannedEventPatch: allows clearing recurrenceRule via empty string', () => {
  const result = validatePlannedEventPatch({ recurrenceRule: '' });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.recurrenceRule, null);
});

test('validatePlannedEventPatch: rejects invalid type on update', () => {
  const result = validatePlannedEventPatch({ type: 'mystery' });
  assert.equal(result.ok, false);
});

test('validatePlannedEventPatch: amount formatting matches POST', () => {
  const result = validatePlannedEventPatch({ amount: 99.5 });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.amount, '99.5000');
});
