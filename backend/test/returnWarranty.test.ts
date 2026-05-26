/**
 * Unit tests for the pure helpers in routes/returnWarranty.ts. Exercises:
 *  - isWithinReturnWindow / isExpiringSoon / daysUntil deadline math
 *  - validateReturnPatch input shape + edge cases
 *  - serializeReturnMetadata view shape with and without metadata
 *  - rowToListView convenience flags
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  daysUntil,
  isWithinReturnWindow,
  isExpiringSoon,
  isoDate,
  validateReturnPatch,
  serializeReturnMetadata,
  rowToListView,
  todayIso,
} from '../src/routes/returnWarranty';
import type { TransactionReturnMetadata } from '../src/models/TransactionReturnMetadata';

// ----- isoDate / todayIso ---------------------------------------------------

test('isoDate returns YYYY-MM-DD in UTC', () => {
  assert.equal(isoDate(new Date('2026-05-26T00:00:00Z')), '2026-05-26');
  assert.equal(isoDate(new Date('2026-01-01T23:59:59Z')), '2026-01-01');
});

test('todayIso() round-trips through isoDate', () => {
  const now = new Date('2026-05-26T12:34:56Z');
  assert.equal(todayIso(now), '2026-05-26');
});

// ----- daysUntil ------------------------------------------------------------

test('daysUntil returns 0 when deadline is today', () => {
  assert.equal(daysUntil('2026-05-26', '2026-05-26'), 0);
});

test('daysUntil returns positive count when deadline is in future', () => {
  assert.equal(daysUntil('2026-06-01', '2026-05-26'), 6);
});

test('daysUntil returns negative count when deadline has passed', () => {
  assert.equal(daysUntil('2026-05-20', '2026-05-26'), -6);
});

test('daysUntil returns null for null/empty input', () => {
  assert.equal(daysUntil(null, '2026-05-26'), null);
  assert.equal(daysUntil('', '2026-05-26'), null);
});

// ----- isWithinReturnWindow -------------------------------------------------

test('isWithinReturnWindow true on the boundary day', () => {
  assert.equal(isWithinReturnWindow('2026-05-26', '2026-05-26'), true);
});

test('isWithinReturnWindow true when deadline is in the future', () => {
  assert.equal(isWithinReturnWindow('2026-06-01', '2026-05-26'), true);
});

test('isWithinReturnWindow false when deadline has passed', () => {
  assert.equal(isWithinReturnWindow('2026-05-25', '2026-05-26'), false);
});

test('isWithinReturnWindow false for null deadline', () => {
  assert.equal(isWithinReturnWindow(null, '2026-05-26'), false);
});

// ----- isExpiringSoon -------------------------------------------------------

test('isExpiringSoon true when within window', () => {
  assert.equal(isExpiringSoon('2026-05-28', 7, '2026-05-26'), true);
});

test('isExpiringSoon true on the inclusive far edge', () => {
  // 2026-05-26 + 7 days = 2026-06-02. Deadline on cutoff still counts.
  assert.equal(isExpiringSoon('2026-06-02', 7, '2026-05-26'), true);
});

test('isExpiringSoon false beyond the window', () => {
  assert.equal(isExpiringSoon('2026-06-03', 7, '2026-05-26'), false);
});

test('isExpiringSoon false for already-expired deadlines', () => {
  assert.equal(isExpiringSoon('2026-05-25', 7, '2026-05-26'), false);
});

test('isExpiringSoon false for null deadline', () => {
  assert.equal(isExpiringSoon(null, 7, '2026-05-26'), false);
});

// ----- validateReturnPatch --------------------------------------------------

test('validateReturnPatch accepts an empty patch', () => {
  const r = validateReturnPatch({});
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, {});
});

test('validateReturnPatch accepts a valid full patch', () => {
  const r = validateReturnPatch({
    returnDeadline: '2026-06-30',
    warrantyEndDate: '2027-05-26',
    notes: 'AppleCare+ until 2027',
    receiptStatus: 'have',
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.returnDeadline, '2026-06-30');
    assert.equal(r.value.warrantyEndDate, '2027-05-26');
    assert.equal(r.value.notes, 'AppleCare+ until 2027');
    assert.equal(r.value.receiptStatus, 'have');
  }
});

test('validateReturnPatch normalizes empty string to null', () => {
  const r = validateReturnPatch({ returnDeadline: '' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.returnDeadline, null);
});

test('validateReturnPatch normalizes explicit null', () => {
  const r = validateReturnPatch({
    returnDeadline: null,
    warrantyEndDate: null,
    notes: null,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.returnDeadline, null);
    assert.equal(r.value.warrantyEndDate, null);
    assert.equal(r.value.notes, null);
  }
});

test('validateReturnPatch rejects malformed dates', () => {
  const r = validateReturnPatch({ returnDeadline: '2026/06/30' });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 400);
    assert.match(r.error, /returnDeadline/);
  }
});

test('validateReturnPatch rejects impossible calendar dates', () => {
  const r = validateReturnPatch({ warrantyEndDate: '2026-02-31' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /warrantyEndDate/);
});

test('validateReturnPatch rejects unknown receiptStatus', () => {
  const r = validateReturnPatch({ receiptStatus: 'bogus' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /receiptStatus/);
});

test('validateReturnPatch truncates excessively long notes', () => {
  const long = 'x'.repeat(5000);
  const r = validateReturnPatch({ notes: long });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.notes?.length, 4000);
});

// ----- serializeReturnMetadata ----------------------------------------------

test('serializeReturnMetadata returns blank view for null meta', () => {
  const v = serializeReturnMetadata(null, '2026-05-26');
  assert.equal(v.transactionId, null);
  assert.equal(v.returnDeadline, null);
  assert.equal(v.warrantyEndDate, null);
  assert.equal(v.notes, null);
  assert.equal(v.receiptStatus, 'unknown');
  assert.equal(v.isWithinReturnWindow, false);
  assert.equal(v.isWarrantyActive, false);
  assert.equal(v.daysUntilReturnDeadline, null);
  assert.equal(v.daysUntilWarrantyEnd, null);
});

test('serializeReturnMetadata fills convenience flags from dates', () => {
  const meta = {
    transactionId: 42,
    returnDeadline: '2026-06-01',
    warrantyEndDate: '2027-05-26',
    notes: null,
    receiptStatus: 'have',
  } as unknown as TransactionReturnMetadata;
  const v = serializeReturnMetadata(meta, '2026-05-26');
  assert.equal(v.transactionId, 42);
  assert.equal(v.isWithinReturnWindow, true);
  assert.equal(v.isWarrantyActive, true);
  assert.equal(v.daysUntilReturnDeadline, 6);
  assert.equal(v.daysUntilWarrantyEnd, 365);
  assert.equal(v.receiptStatus, 'have');
});

test('serializeReturnMetadata marks expired window false', () => {
  const meta = {
    transactionId: 9,
    returnDeadline: '2026-04-01',
    warrantyEndDate: null,
    notes: null,
    receiptStatus: 'unknown',
  } as unknown as TransactionReturnMetadata;
  const v = serializeReturnMetadata(meta, '2026-05-26');
  assert.equal(v.isWithinReturnWindow, false);
  assert.ok((v.daysUntilReturnDeadline ?? 0) < 0);
});

// ----- rowToListView --------------------------------------------------------

test('rowToListView populates account + hasReceipt + days', () => {
  const v = rowToListView(
    {
      id: 17,
      date: '2026-05-01',
      merchantClean: 'Apple Store',
      amount: '-1299.0000',
      currency: 'CAD',
      finalCategory: 'electronics',
      account: { id: 3, name: 'Visa Infinite' },
      receipts: [{ id: 100 }],
      returnMetadata: {
        transactionId: 17,
        returnDeadline: '2026-06-15',
        warrantyEndDate: '2027-05-01',
        notes: 'Bought at Eaton Centre',
        receiptStatus: 'have',
      } as unknown as TransactionReturnMetadata,
    },
    '2026-05-26',
  );
  assert.equal(v.id, 17);
  assert.equal(v.merchant, 'Apple Store');
  assert.equal(v.accountName, 'Visa Infinite');
  assert.equal(v.amount, '-1299.0000');
  assert.equal(v.hasReceipt, true);
  assert.equal(v.receiptStatus, 'have');
  assert.equal(v.returnDeadline, '2026-06-15');
  assert.equal(v.daysUntilReturnDeadline, 20);
  assert.equal(v.daysUntilWarrantyEnd, 340);
});

test('rowToListView handles missing metadata gracefully', () => {
  const v = rowToListView(
    {
      id: 18,
      date: '2026-05-02',
      merchantClean: 'Best Buy',
      amount: '-200',
      currency: 'CAD',
      finalCategory: null,
      account: null,
      receipts: [],
      returnMetadata: null,
    },
    '2026-05-26',
  );
  assert.equal(v.returnDeadline, null);
  assert.equal(v.warrantyEndDate, null);
  assert.equal(v.receiptStatus, 'unknown');
  assert.equal(v.hasReceipt, false);
  assert.equal(v.daysUntilReturnDeadline, null);
});
