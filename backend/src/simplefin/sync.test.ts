import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BACKFILL_WINDOW_DAYS,
  mapSimplefinTransaction,
  postedToDate,
  resolutionFailureReason,
  resolveAccountId,
  startDateEpoch,
} from './sync';

// Regression cover for a sync that ran daily for three months and imported
// nothing while reporting success.
//
// The 20260628000001 migration backfilled simplefin_account_links with the
// Cashflow account NAME in the simplefin_account_id column, as a placeholder,
// on the stated assumption that "sync resolves by account_id regardless". It
// does not — resolveAccountId looks the remote ACT-… id up against exactly that
// column, so every account missed. The run then logged
// simplefin_sync_account_unresolved per account, produced an empty runs array,
// and the job computed errors = runs.filter(status === 'error').length = 0.
//
// errors=0 with accountRuns=0 is indistinguishable from "nothing new to import",
// so no alert could fire. Total resolution failure has to be loud.

test('total resolution failure is reported when links exist but none resolve', () => {
  assert.equal(resolutionFailureReason(29, 0), 'links_unresolved');
});

test('an integration with no links yet is not a failure', () => {
  // Freshly connected, nothing linked through the UI: legitimately nothing to do.
  assert.equal(resolutionFailureReason(0, 0), null);
});

test('full resolution is not a failure', () => {
  assert.equal(resolutionFailureReason(29, 29), null);
});

test('partial resolution is not treated as total failure', () => {
  // One stale link among many is a per-account warning, not a reason to fail the
  // run and hold back the sync window for the accounts that did resolve.
  assert.equal(resolutionFailureReason(29, 28), null);
  assert.equal(resolutionFailureReason(29, 1), null);
});

// ── sync mapping helpers (issue #791) ──────────────────────────────────────
// Pure functions, no DB, no network: field mapping (AC2), the first-sync
// backfill window (AC7), epoch→date conversion, and account resolution. Merged
// in from the pre-colocation holdover backend/test/simplefinSyncMapping.test.ts,
// which sat in neither suite until commit 8a6211a6.

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
