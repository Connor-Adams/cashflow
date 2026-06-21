import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideMemoryFanout } from './transactions';

const baseTxn = {
  householdId: 7,
  reviewedAt: new Date('2026-04-01T12:00:00Z'),
  finalCategory: 'Groceries',
  merchantClean: 'COSTCO WHOLESALE',
};

test('fires when row transitions unreviewed → reviewed with a category', () => {
  const out = decideMemoryFanout({ reviewedAt: null, finalCategory: null }, baseTxn);
  assert.deepEqual(out, { householdId: 7, merchantPattern: 'COSTCO WHOLESALE' });
});

test('fires when finalCategory changes on an already-reviewed row', () => {
  const out = decideMemoryFanout(
    { reviewedAt: new Date('2026-03-01T00:00:00Z'), finalCategory: 'Misc' },
    baseTxn,
  );
  assert.deepEqual(out, { householdId: 7, merchantPattern: 'COSTCO WHOLESALE' });
});

test('skips when already reviewed and category unchanged', () => {
  const out = decideMemoryFanout(
    { reviewedAt: new Date('2026-03-01T00:00:00Z'), finalCategory: 'Groceries' },
    baseTxn,
  );
  assert.equal(out, null);
});

test('skips when row is not (yet) reviewed', () => {
  const out = decideMemoryFanout(
    { reviewedAt: null, finalCategory: null },
    { ...baseTxn, reviewedAt: null },
  );
  assert.equal(out, null);
});

test('skips when finalCategory is null or empty', () => {
  const outNull = decideMemoryFanout(
    { reviewedAt: null, finalCategory: null },
    { ...baseTxn, finalCategory: null },
  );
  assert.equal(outNull, null);
  const outEmpty = decideMemoryFanout(
    { reviewedAt: null, finalCategory: null },
    { ...baseTxn, finalCategory: '' },
  );
  assert.equal(outEmpty, null);
});

test('skips when householdId is null (orphan txn)', () => {
  const out = decideMemoryFanout(
    { reviewedAt: null, finalCategory: null },
    { ...baseTxn, householdId: null },
  );
  assert.equal(out, null);
});

test('skips when merchantClean is missing', () => {
  const out = decideMemoryFanout(
    { reviewedAt: null, finalCategory: null },
    { ...baseTxn, merchantClean: '' },
  );
  assert.equal(out, null);
});
