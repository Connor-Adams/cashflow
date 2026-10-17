import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BACKFILL_WINDOW_DAYS,
  STALE_BALANCE_DAYS,
  SYNC_LOOKBACK_DAYS,
  dropCoveredTransactions,
  institutionAttentionReason,
  isBalanceStale,
  mapSimplefinTransaction,
  postedToDate,
  resolutionFailureReason,
  resolveAccountId,
  startDateEpoch,
  syncRunFailureMessage,
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

const DAY_MS = 24 * 60 * 60 * 1000;
const epochOf = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

test('startDateEpoch looks back SYNC_LOOKBACK_DAYS before lastSyncedAt', () => {
  const now = new Date('2025-06-01T00:00:00.000Z');
  const last = new Date('2025-05-30T10:00:00.000Z');
  assert.equal(
    startDateEpoch(last, now),
    Math.floor((last.getTime() - SYNC_LOOKBACK_DAYS * DAY_MS) / 1000),
  );
});

// Regression: from 2026-10-04 every nightly run inserted zero rows. SimpleFIN
// stamps `posted` at 12:00 UTC on the transaction's date and only learns about
// a charge when it next refreshes the institution (Amex: ~05:35 UTC, a day or
// two after the charge). The sync asked for `start-date = lastSyncedAt`, the
// previous 02:00 UTC run, so a charge first seen after that run was already
// dated before the window opened. It was excluded that night and every night
// after. Replaying the 2026-10-17 run against prod returned 0 transactions
// across all 22 accounts while the Amex feed held 39.
test('a charge that surfaces after the previous run is still inside the next window', () => {
  const lastSyncedAt = new Date('2026-10-16T02:00:00.000Z');
  const now = new Date('2026-10-17T02:00:00.000Z');
  const postedTheDayBefore = epochOf('2026-10-15T12:00:00.000Z');
  assert.ok(startDateEpoch(lastSyncedAt, now) <= postedTheDayBefore);
});

test('startDateEpoch never reaches back past the first-sync backfill window', () => {
  const now = new Date('2026-10-17T02:00:00.000Z');
  const ancient = new Date('2026-01-01T00:00:00.000Z');
  assert.equal(startDateEpoch(ancient, now), startDateEpoch(null, now));
});

// ── institution health ─────────────────────────────────────────────────────
// SimpleFIN reports a broken institution connection in the payload's top-level
// `errors` array and keeps answering 200 with that institution's last good
// balance. Prod on 2026-10-17: RBC "Broken" (balance-date 2026-06-21),
// Wealthsimple credential mismatch (2026-10-08), CIBC "Auth required"
// (2026-09-27). None of it was read, so every run reported success.

test('isBalanceStale flags a balance SimpleFIN has not refreshed in days', () => {
  const now = new Date('2026-10-17T02:00:00.000Z');
  assert.equal(isBalanceStale(epochOf('2026-06-21T01:30:23.000Z'), now), true);
  assert.equal(isBalanceStale(epochOf('2026-10-16T05:35:38.000Z'), now), false);
  assert.equal(
    isBalanceStale(Math.floor((now.getTime() - (STALE_BALANCE_DAYS + 1) * DAY_MS) / 1000), now),
    true,
  );
});

test('isBalanceStale does not guess when SimpleFIN omits balance-date', () => {
  assert.equal(isBalanceStale(null, new Date()), false);
});

test('institutionAttentionReason is null for a healthy fetch', () => {
  assert.equal(institutionAttentionReason([], []), null);
});

test('institutionAttentionReason carries the SimpleFIN errors and stale accounts', () => {
  const reason = institutionAttentionReason(
    ['Connection to Royal Bank of Canada  may need attention. Broken.'],
    ['RBC Day to Day Banking (6985)'],
  );
  assert.ok(reason);
  assert.match(reason, /^institution_attention: /);
  assert.match(reason, /Royal Bank of Canada/);
  assert.match(reason, /RBC Day to Day Banking \(6985\)/);
});

test('institutionAttentionReason flags staleness even when SimpleFIN sends no error', () => {
  assert.match(institutionAttentionReason([], ['CASH (Ng7g)']) ?? '', /CASH \(Ng7g\)/);
});

// ── coverage floor ─────────────────────────────────────────────────────────
// The lookback re-fetches days that may already hold rows from a statement or
// CSV import. Commit-path dedup cannot match those: both sides carry a
// reference (SimpleFIN TRN-… vs the statement's own) and the payee text
// differs ("Guelph Grotto" vs "GUELPH GROTTO GUELPH"), so they would insert
// twice. Feed rows dated before the newest imported row are left to the import.

const row = (date: string) =>
  mapSimplefinTransaction(
    { id: `TRN-${date}`, posted: epochOf(`${date}T12:00:00.000Z`), amount: '-1', description: 'X' },
    1,
    'CAD',
  );

test('dropCoveredTransactions keeps everything when no import covers the account', () => {
  const rows = [row('2026-10-01'), row('2026-10-02')];
  assert.deepEqual(dropCoveredTransactions(rows, null), { kept: rows, covered: 0 });
});

test('dropCoveredTransactions drops rows dated before the newest imported row', () => {
  const rows = [row('2026-09-23'), row('2026-09-24'), row('2026-09-25')];
  const { kept, covered } = dropCoveredTransactions(rows, '2026-09-24');
  assert.equal(covered, 1);
  // The floor day itself still goes through commit-path dedup: a statement can
  // close mid-day, and dedup matches same-day rows that share a merchant.
  assert.deepEqual(kept.map((r) => r.date), ['2026-09-24', '2026-09-25']);
});

// ── job outcome ────────────────────────────────────────────────────────────

test('syncRunFailureMessage is null for a clean run, including a quiet zero-insert day', () => {
  assert.equal(syncRunFailureMessage({ errors: 0, institutionErrors: [] }), null);
});

test('syncRunFailureMessage fails the run on error runs or institution errors', () => {
  assert.match(syncRunFailureMessage({ errors: 3, institutionErrors: [] }) ?? '', /3 account run/);
  assert.match(
    syncRunFailureMessage({ errors: 0, institutionErrors: ['Connection to CIBC may need attention.'] }) ?? '',
    /CIBC/,
  );
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
