import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSettlementInput } from '../src/routes/settlements';

test('validateSettlementInput: rejects non-positive amount', () => {
  const result = validateSettlementInput({
    contactId: 1,
    direction: 'i_paid_partner',
    currency: 'CAD',
    amount: 0,
    settledDate: '2026-05-20',
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.match(result.error, /amount must be a positive number/);
  }
});

test('validateSettlementInput: rejects negative amount', () => {
  const result = validateSettlementInput({
    contactId: 1,
    direction: 'i_paid_partner',
    currency: 'CAD',
    amount: -5,
    settledDate: '2026-05-20',
  });
  assert.equal(result.ok, false);
});

test('validateSettlementInput: rejects non-numeric amount', () => {
  const result = validateSettlementInput({
    contactId: 1,
    direction: 'i_paid_partner',
    currency: 'CAD',
    amount: 'not-a-number',
    settledDate: '2026-05-20',
  });
  assert.equal(result.ok, false);
});

test('validateSettlementInput: rejects unknown direction', () => {
  const result = validateSettlementInput({
    contactId: 1,
    direction: 'bogus',
    currency: 'CAD',
    amount: 10,
    settledDate: '2026-05-20',
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.match(result.error, /direction must be one of/);
  }
});

test('validateSettlementInput: accepts both enum values', () => {
  for (const direction of ['i_paid_partner', 'partner_paid_me'] as const) {
    const result = validateSettlementInput({
      contactId: 7,
      direction,
      currency: 'CAD',
      amount: 25,
      settledDate: '2026-05-20',
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.direction, direction);
  }
});

test('validateSettlementInput: rejects missing or invalid contactId', () => {
  const a = validateSettlementInput({
    direction: 'i_paid_partner',
    currency: 'CAD',
    amount: 10,
  });
  assert.equal(a.ok, false);
  const b = validateSettlementInput({
    contactId: 'oops',
    direction: 'i_paid_partner',
    currency: 'CAD',
    amount: 10,
  });
  assert.equal(b.ok, false);
});

test('validateSettlementInput: rejects bad currency length', () => {
  const result = validateSettlementInput({
    contactId: 1,
    direction: 'i_paid_partner',
    currency: 'CADS',
    amount: 10,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /3-letter ISO code/);
});

test('validateSettlementInput: normalizes currency to uppercase', () => {
  const result = validateSettlementInput({
    contactId: 1,
    direction: 'i_paid_partner',
    currency: 'cad',
    amount: 10,
    settledDate: '2026-05-20',
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.currency, 'CAD');
});

test('validateSettlementInput: defaults settledDate to today (YYYY-MM-DD) when missing', () => {
  const result = validateSettlementInput({
    contactId: 1,
    direction: 'i_paid_partner',
    currency: 'CAD',
    amount: 10,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.value.settledDate, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('validateSettlementInput: rejects malformed settledDate string', () => {
  const result = validateSettlementInput({
    contactId: 1,
    direction: 'i_paid_partner',
    currency: 'CAD',
    amount: 10,
    settledDate: '20260520',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /YYYY-MM-DD/);
});

test('validateSettlementInput: formats amount to 4 decimal places', () => {
  const result = validateSettlementInput({
    contactId: 1,
    direction: 'i_paid_partner',
    currency: 'CAD',
    amount: 12.345,
    settledDate: '2026-05-20',
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.amount, '12.3450');
});

test('validateSettlementInput: empty notes normalized to null', () => {
  const result = validateSettlementInput({
    contactId: 1,
    direction: 'i_paid_partner',
    currency: 'CAD',
    amount: 10,
    settledDate: '2026-05-20',
    notes: '   ',
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.notes, null);
});

test('validateSettlementInput: preserves notes string', () => {
  const result = validateSettlementInput({
    contactId: 1,
    direction: 'i_paid_partner',
    currency: 'CAD',
    amount: 10,
    settledDate: '2026-05-20',
    notes: 'cash, thanks',
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.notes, 'cash, thanks');
});
