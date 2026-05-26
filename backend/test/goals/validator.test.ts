/**
 * Unit tests for the pure validators on /api/goals. Exercised without a DB
 * so we can rapidly cover the input edge cases.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateGoalInput,
  validateGoalPatch,
} from '../../src/routes/goals.js';

// ---- validateGoalInput ---------------------------------------------------

test('validateGoalInput: accepts a minimal valid goal', () => {
  const result = validateGoalInput({
    name: 'Emergency fund',
    targetAmount: 10000,
    currency: 'CAD',
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.name, 'Emergency fund');
    assert.equal(result.value.targetAmount, '10000.0000');
    assert.equal(result.value.currentAmount, '0.0000');
    assert.equal(result.value.currency, 'CAD');
    assert.equal(result.value.targetDate, null);
    assert.equal(result.value.monthlyContribution, null);
    assert.equal(result.value.linkedAccountId, null);
    assert.equal(result.value.priority, 0);
    assert.equal(result.value.status, 'active');
    assert.equal(result.value.notes, null);
  }
});

test('validateGoalInput: uppercases currency', () => {
  const result = validateGoalInput({
    name: 'Trip',
    targetAmount: 100,
    currency: 'cad',
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.currency, 'CAD');
});

test('validateGoalInput: requires name', () => {
  const result = validateGoalInput({
    name: '   ',
    targetAmount: 100,
    currency: 'CAD',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /name is required/);
});

test('validateGoalInput: rejects negative targetAmount', () => {
  const result = validateGoalInput({
    name: 'Trip',
    targetAmount: -10,
    currency: 'CAD',
  });
  assert.equal(result.ok, false);
});

test('validateGoalInput: rejects zero targetAmount', () => {
  const result = validateGoalInput({
    name: 'Trip',
    targetAmount: 0,
    currency: 'CAD',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /targetAmount must be greater than 0/);
});

test('validateGoalInput: rejects non-finite targetAmount', () => {
  const result = validateGoalInput({
    name: 'Trip',
    targetAmount: 'huge',
    currency: 'CAD',
  });
  assert.equal(result.ok, false);
});

test('validateGoalInput: rejects negative currentAmount', () => {
  const result = validateGoalInput({
    name: 'Trip',
    targetAmount: 100,
    currency: 'CAD',
    currentAmount: -1,
  });
  assert.equal(result.ok, false);
});

test('validateGoalInput: rejects bad currency', () => {
  const result = validateGoalInput({
    name: 'Trip',
    targetAmount: 100,
    currency: 'CA',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /3-letter ISO code/);
});

test('validateGoalInput: rejects bad date format', () => {
  const result = validateGoalInput({
    name: 'Trip',
    targetAmount: 100,
    currency: 'CAD',
    targetDate: '06/01/2027',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /YYYY-MM-DD/);
});

test('validateGoalInput: accepts ISO target date', () => {
  const result = validateGoalInput({
    name: 'Trip',
    targetAmount: 100,
    currency: 'CAD',
    targetDate: '2027-06-01',
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.targetDate, '2027-06-01');
});

test('validateGoalInput: rejects invalid status', () => {
  const result = validateGoalInput({
    name: 'Trip',
    targetAmount: 100,
    currency: 'CAD',
    status: 'archived',
  });
  assert.equal(result.ok, false);
});

test('validateGoalInput: rejects negative priority', () => {
  const result = validateGoalInput({
    name: 'Trip',
    targetAmount: 100,
    currency: 'CAD',
    priority: -1,
  });
  assert.equal(result.ok, false);
});

test('validateGoalInput: rejects negative monthlyContribution', () => {
  const result = validateGoalInput({
    name: 'Trip',
    targetAmount: 100,
    currency: 'CAD',
    monthlyContribution: -1,
  });
  assert.equal(result.ok, false);
});

test('validateGoalInput: accepts zero monthlyContribution as null (no intent)', () => {
  const result = validateGoalInput({
    name: 'Trip',
    targetAmount: 100,
    currency: 'CAD',
    monthlyContribution: 0,
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.monthlyContribution, '0.0000');
});

test('validateGoalInput: rejects non-integer linkedAccountId', () => {
  const result = validateGoalInput({
    name: 'Trip',
    targetAmount: 100,
    currency: 'CAD',
    linkedAccountId: 'abc',
  });
  assert.equal(result.ok, false);
});

test('validateGoalInput: rejects negative linkedAccountId', () => {
  const result = validateGoalInput({
    name: 'Trip',
    targetAmount: 100,
    currency: 'CAD',
    linkedAccountId: -3,
  });
  assert.equal(result.ok, false);
});

// ---- validateGoalPatch ---------------------------------------------------

test('validateGoalPatch: empty patch is valid', () => {
  const result = validateGoalPatch({});
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, {});
});

test('validateGoalPatch: allows partial status update', () => {
  const result = validateGoalPatch({ status: 'paused' });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.status, 'paused');
});

test('validateGoalPatch: rejects empty name', () => {
  const result = validateGoalPatch({ name: '   ' });
  assert.equal(result.ok, false);
});

test('validateGoalPatch: rejects zero targetAmount', () => {
  const result = validateGoalPatch({ targetAmount: 0 });
  assert.equal(result.ok, false);
});

test('validateGoalPatch: allows current_amount update (top-ups)', () => {
  const result = validateGoalPatch({ currentAmount: 250 });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.currentAmount, '250.0000');
});

test('validateGoalPatch: allows clearing targetDate via null', () => {
  const result = validateGoalPatch({ targetDate: null });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.targetDate, null);
});

test('validateGoalPatch: allows clearing linkedAccountId via null', () => {
  const result = validateGoalPatch({ linkedAccountId: null });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.linkedAccountId, null);
});

test('validateGoalPatch: rejects invalid status on update', () => {
  const result = validateGoalPatch({ status: 'archived' });
  assert.equal(result.ok, false);
});
