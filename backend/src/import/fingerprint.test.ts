/**
 * GOLDEN-HASH REGRESSION TEST for the import dedup fingerprints.
 *
 * These pin the EXACT SHA-256 output of `stableIdentityFingerprint` (and
 * `rowFingerprint`) for a fixed set of representative inputs. The fingerprint
 * is the persisted dedup key on every Transaction row
 * (`source_identity_fingerprint`); the entire dedup chain in
 * `findExistingForDedup` looks rows up by it.
 *
 * WHY THIS EXISTS — DO NOT "FIX" A FAILURE BY UPDATING THE HASHES.
 * Any change to the hashing algorithm (field set, ordering, number/string
 * coercion, currency casing, JSON shape) silently changes EVERY fingerprint.
 * Already-stored rows keep their OLD hashes, so a re-imported CSV no longer
 * matches them and inserts duplicates — double-counting spend with no error.
 * If you intentionally change the algorithm you MUST ship a re-fingerprint
 * data migration that rewrites `source_identity_fingerprint` (and the audit
 * `source_row_fingerprint`) on existing rows, and only THEN update these
 * golden values. A bare hash update here without that migration is a bug.
 *
 * Properties these cases lock in on purpose:
 *   - `10.5` and `10.50` hash IDENTICALLY (JS `String(10.50)` === "10.5"),
 *     so trailing-zero amount formatting never forks a fingerprint.
 *   - currency is upper-cased ("usd" hashes the same as "USD").
 *   - accented / punctuated merchantRaw is hashed verbatim (no normalization).
 *   - `stableIdentityFingerprint` is INVARIANT to sourceReference and status
 *     (it hashes neither) — the row's null-vs-set ref does not change it.
 *   - `rowFingerprint` DOES include sourceReference, so null vs set diverge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowFingerprint, stableIdentityFingerprint } from './fingerprint';

test('stableIdentityFingerprint: golden hashes for representative inputs', () => {
  const golden: Array<[string, Parameters<typeof stableIdentityFingerprint>[0], string]> = [
    [
      'cad integer amount',
      { accountId: 1, date: '2026-01-15', amount: -42, currency: 'CAD', merchantRaw: 'TIM HORTONS #123' },
      '63d6cf0d5bce5eebf1cb15416bc74c1da3b57f7d2e9a21b460c2de84e0e90215',
    ],
    [
      'usd lower-cased currency + mixed-case merchant',
      { accountId: 7, date: '2025-12-31', amount: -1234.56, currency: 'usd', merchantRaw: 'AMZN Mktp US*A1B2C3' },
      '6e0e868038dafa50b563f4b29c6bccbc6aa2cee497d25b171fbe08373244c77d',
    ],
    [
      'accented + punctuated merchant (EUR)',
      { accountId: 2, date: '2026-03-09', amount: -19.99, currency: 'EUR', merchantRaw: 'Café Déjà-Vu, #4 (Montréal)' },
      '1eac26a21459dc2dbbabda191ee25785f91d5543fc3840d7697cc090c31af9fe',
    ],
    [
      'zero amount + empty merchant (GBP)',
      { accountId: 3, date: '2026-06-01', amount: 0, currency: 'GBP', merchantRaw: '' },
      '5c418afa05bdfe7c73588b9ba33c12f99b8da63de5c40c7eb1d83e4d969ca1c1',
    ],
  ];
  for (const [label, payload, expected] of golden) {
    assert.equal(stableIdentityFingerprint(payload), expected, `golden hash drift: ${label}`);
  }
});

test('stableIdentityFingerprint: 10.5 and 10.50 produce the SAME hash (no trailing-zero fork)', () => {
  const a = stableIdentityFingerprint({
    accountId: 1, date: '2026-01-15', amount: 10.5, currency: 'CAD', merchantRaw: 'REFUND',
  });
  const b = stableIdentityFingerprint({
    accountId: 1, date: '2026-01-15', amount: 10.50, currency: 'CAD', merchantRaw: 'REFUND',
  });
  assert.equal(a, '99c0431a08e45bd1623fe0011ccebf4c531b9f724a3d3e98f1311c5fdf40dc54');
  assert.equal(a, b);
});

test('stableIdentityFingerprint: invariant to sourceReference (matches a known golden)', () => {
  // The function takes no sourceReference; this just pins that the identity of
  // an otherwise-fixed payload is stable. rowFingerprint (below) is where a ref
  // is allowed to change the hash.
  const payload = {
    accountId: 5, date: '2026-02-20', amount: -88.25, currency: 'CAD', merchantRaw: 'WALMART #3026',
  };
  assert.equal(
    stableIdentityFingerprint(payload),
    '65a4e7b133fcb337ea258efdb8d29770f884951c900944f4a132083fee1d5c4a',
  );
});

test('rowFingerprint: null vs set sourceReference diverge (golden hashes)', () => {
  const base = {
    accountId: 5, date: '2026-02-20', amount: -88.25, currency: 'CAD', merchantRaw: 'WALMART #3026',
  };
  assert.equal(
    rowFingerprint({ ...base, sourceReference: null }),
    '19e5d033ddf3348508feb2c37acf72ca005f1868e87e491a9f650b43bc500db2',
  );
  assert.equal(
    rowFingerprint({ ...base, sourceReference: 'AT2026-9988' }),
    'f43f5277b8dece91b73f4e313a6b9708be6f23b76d8849b70a26179a72e55094',
  );
});
