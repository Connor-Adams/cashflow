/**
 * Unit tests for the SimpleFIN sync mapping helpers (issue #791) — pure
 * functions, no DB, no network. Covers field mapping (AC2), the first-sync
 * backfill window (AC7), epoch→date conversion, and account resolution.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKFILL_WINDOW_DAYS,
  mapSimplefinTransaction,
  postedToDate,
  resolveAccountId,
  startDateEpoch,
} from '../src/simplefin/sync.js';

test('postedToDate converts epoch seconds to UTC YYYY-MM-DD', () => {
  // 2025-03-15T12:00:00Z
  assert.equal(postedToDate(1742040000), '2025-03-15');
});

test('AC2: mapSimplefinTransaction maps posted/amount/currency/payee and id→sourceReference', () => {
  const tx = {
    id: 'STX-99',
    posted: 1742040000,
    amount: '-12.34',
    description: 'POS PURCHASE STARBUCKS',
    payee: 'Starbucks',
  };
  const n = mapSimplefinTransaction(tx, 7, 'usd');
  assert.equal(n.date, '2025-03-15');
  assert.equal(n.amount, -12.34);
  assert.equal(n.currency, 'usd');
  assert.equal(n.sourceReference, 'STX-99');
  // payee wins over description for merchantRaw.
  assert.equal(n.merchantRaw, 'Starbucks');
  assert.ok(n.merchantClean.length > 0);
  assert.ok(n.sourceRowFingerprint.length === 64);
});

test('AC2: merchantRaw falls back to description when payee is empty', () => {
  const n = mapSimplefinTransaction(
    { id: 'X', posted: 1742040000, amount: '5', description: 'INTEREST PAID', payee: null },
    1,
    'CAD',
  );
  assert.equal(n.merchantRaw, 'INTEREST PAID');
});

test('AC7: startDateEpoch backfills 90 days when lastSyncedAt is null', () => {
  const now = new Date('2025-06-01T00:00:00.000Z');
  const epoch = startDateEpoch(null, now);
  const expected = Math.floor(
    (now.getTime() - BACKFILL_WINDOW_DAYS * 24 * 60 * 60 * 1000) / 1000,
  );
  assert.equal(epoch, expected);
});

test('startDateEpoch uses lastSyncedAt when present', () => {
  const now = new Date('2025-06-01T00:00:00.000Z');
  const last = new Date('2025-05-30T10:00:00.000Z');
  assert.equal(startDateEpoch(last, now), Math.floor(last.getTime() / 1000));
});

test('#813: resolveAccountId returns the linked accountId for a known simplefin id', () => {
  const links = new Map<string, number>([
    ['ACT-1', 10],
    ['ACT-2', 11],
  ]);
  assert.equal(resolveAccountId({ id: 'ACT-1' }, links), 10);
});

test('#813: resolveAccountId returns null for an unlinked simplefin id (no name fallback)', () => {
  const links = new Map<string, number>([['ACT-1', 10]]);
  assert.equal(resolveAccountId({ id: 'ACT-UNLINKED' }, links), null);
  assert.equal(resolveAccountId({ id: 'ACT-1' }, new Map()), null);
});
