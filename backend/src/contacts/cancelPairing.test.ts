import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCancelledTransferIds } from './cancelPairing';

test('a cancel and its original both drop out', () => {
  const ids = findCancelledTransferIds([
    { id: 1, merchantText: 'E-TRANSFER SENT EVAN LEROSE DPKGQG' },
    { id: 2, merchantText: 'E-TRANSFER CANCEL EVAN LEROSE DPKGQG' },
  ]);
  assert.deepEqual([...ids].sort((a, b) => a - b), [1, 2]);
});

test('request-fulfilled originals pair too', () => {
  const ids = findCancelledTransferIds([
    { id: 3, merchantText: 'E-TRANSFER REQUEST FULFILLED EVAN LEROSE B2ZVYD' },
    { id: 4, merchantText: 'E-TRANSFER CANCEL EVAN LEROSE B2ZVYD' },
  ]);
  assert.deepEqual([...ids].sort((a, b) => a - b), [3, 4]);
});

test('a cancel with no matching original is left alone', () => {
  const ids = findCancelledTransferIds([
    { id: 5, merchantText: 'E-TRANSFER CANCEL EVAN LEROSE ZZZZZZ' },
  ]);
  assert.equal(ids.size, 0, 'dropping a lone cancel would hide real money');
});

test('unrelated transfers are untouched', () => {
  const ids = findCancelledTransferIds([
    { id: 6, merchantText: 'E-TRANSFER SENT EVAN ADCOCK' },
    { id: 7, merchantText: 'ONLINE TRANSFER SENT - 8807 CAELAN ITEN-MCGRATH' },
    { id: 8, merchantText: null },
  ]);
  assert.equal(ids.size, 0);
});

test('two sends sharing one code both pair with a single cancel', () => {
  const ids = findCancelledTransferIds([
    { id: 9, merchantText: 'E-TRANSFER SENT EVAN LEROSE W8XN3J' },
    { id: 10, merchantText: 'E-TRANSFER CANCEL EVAN LEROSE W8XN3J' },
    { id: 11, merchantText: 'E-TRANSFER SENT EVAN LEROSE W8XN3J' },
  ]);
  assert.deepEqual([...ids].sort((a, b) => a - b), [9, 10, 11]);
});
