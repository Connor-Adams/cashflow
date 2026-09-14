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

test('an ambiguous code with two originals and one cancel excludes nothing', () => {
  // A trailing surname can collide across unrelated transfers and act as a
  // pseudo-code. With two originals sharing it, the cancel can't be matched
  // to either one, so nothing for this code should be excluded.
  const ids = findCancelledTransferIds([
    { id: 9, merchantText: 'E-TRANSFER SENT EVAN LEROSE W8XN3J' },
    { id: 10, merchantText: 'E-TRANSFER SENT EVAN LEROSE W8XN3J' },
    { id: 11, merchantText: 'E-TRANSFER CANCEL EVAN LEROSE W8XN3J' },
  ]);
  assert.equal(ids.size, 0, 'an ambiguous pairing must not hide any of these rows');
});

test('one original with two cancels for the same code excludes nothing', () => {
  const ids = findCancelledTransferIds([
    { id: 12, merchantText: 'E-TRANSFER SENT EVAN LEROSE Q7F3ZK' },
    { id: 13, merchantText: 'E-TRANSFER CANCEL EVAN LEROSE Q7F3ZK' },
    { id: 14, merchantText: 'E-TRANSFER CANCEL EVAN LEROSE Q7F3ZK' },
  ]);
  assert.equal(ids.size, 0, 'an ambiguous pairing must not hide any of these rows');
});

test('a trailing surname acting as the shared code still pairs when unambiguous', () => {
  // EVAN ADCOCK: the surname ADCOCK is captured as the "code" here, exactly
  // like the ambiguous cases above. But with exactly one original and exactly
  // one cancel sharing it, the pairing is unambiguous and safe to exclude —
  // pinning that this is deliberate, not accidental.
  const ids = findCancelledTransferIds([
    { id: 15, merchantText: 'E-TRANSFER SENT EVAN ADCOCK' },
    { id: 16, merchantText: 'E-TRANSFER CANCEL EVAN ADCOCK' },
  ]);
  assert.deepEqual([...ids].sort((a, b) => a - b), [15, 16]);
});

test('E-TRANSFER CANCELLATION FEE is not treated as a cancel', () => {
  const ids = findCancelledTransferIds([
    { id: 17, merchantText: 'E-TRANSFER SENT EVAN LEROSE DPKGQG' },
    { id: 18, merchantText: 'E-TRANSFER CANCELLATION FEE DPKGQG' },
  ]);
  assert.equal(
    ids.size,
    0,
    'CANCELLATION FEE must not match the CANCEL marker, so no pairing should occur',
  );
});
