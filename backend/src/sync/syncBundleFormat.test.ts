/**
 * bundleFormat — encrypt/decrypt round-trip + failure modes (Cashflow #239).
 *
 * The codec is the security boundary for the local-first sync foundation,
 * so these tests cover: success path, wrong-passphrase rejection, tamper
 * detection (envelope and ciphertext), version-byte rejection, future-
 * schemaVersion rejection, and the static-input randomness invariant.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUNDLE_SCHEMA_VERSION,
  bundleStats,
  decryptBundle,
  encryptBundle,
  type BundlePayload,
} from './bundleFormat';

function samplePayload(overrides: Partial<BundlePayload> = {}): BundlePayload {
  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    createdAt: '2026-05-26T00:00:00.000Z',
    origin: 'cashflow-test',
    sourceHouseholdId: 42,
    tables: {
      households: [{ id: 42, name: 'Test household' }],
      transactions: [
        { id: 1, amount: '12.34', currency: 'CAD' },
        { id: 2, amount: '56.78', currency: 'CAD' },
      ],
    },
    ...overrides,
  };
}

test('encryptBundle / decryptBundle round-trips an object payload', () => {
  const payload = samplePayload();
  const enc = encryptBundle('correct horse battery staple', payload);
  assert.ok(typeof enc === 'string' && enc.length > 0);
  const dec = decryptBundle('correct horse battery staple', enc);
  assert.equal(dec.schemaVersion, BUNDLE_SCHEMA_VERSION);
  assert.equal(dec.createdAt, payload.createdAt);
  assert.equal(dec.origin, payload.origin);
  assert.equal(dec.sourceHouseholdId, 42);
  assert.deepEqual(dec.tables, payload.tables);
});

test('encryptBundle produces a different ciphertext on each call (random salt + IV)', () => {
  const payload = samplePayload();
  const a = encryptBundle('passphrase-one', payload);
  const b = encryptBundle('passphrase-one', payload);
  assert.notEqual(a, b);
  assert.deepEqual(decryptBundle('passphrase-one', a).tables, payload.tables);
  assert.deepEqual(decryptBundle('passphrase-one', b).tables, payload.tables);
});

test('decryptBundle rejects the wrong passphrase (auth-tag failure)', () => {
  const enc = encryptBundle('right-passphrase', samplePayload());
  assert.throws(() => decryptBundle('wrong-passphrase', enc));
});

test('decryptBundle rejects a tampered ciphertext (one bit flip in payload)', () => {
  const enc = encryptBundle('any-passphrase', samplePayload());
  const buf = Buffer.from(enc, 'base64');
  // Flip a bit deep in the ciphertext body (past the header).
  buf[buf.length - 5] ^= 0x01;
  assert.throws(() => decryptBundle('any-passphrase', buf.toString('base64')));
});

test('decryptBundle rejects a tampered auth tag', () => {
  const enc = encryptBundle('any-passphrase', samplePayload());
  const buf = Buffer.from(enc, 'base64');
  // Header layout: version(1) || salt(16) || iv(12) || tag(16). Flip in tag.
  buf[1 + 16 + 12] ^= 0x01;
  assert.throws(() => decryptBundle('any-passphrase', buf.toString('base64')));
});

test('decryptBundle rejects an unknown envelope version byte', () => {
  const enc = encryptBundle('any-passphrase', samplePayload());
  const buf = Buffer.from(enc, 'base64');
  buf[0] = 0xff;
  assert.throws(
    () => decryptBundle('any-passphrase', buf.toString('base64')),
    /version/i,
  );
});

test('decryptBundle rejects an empty/short envelope', () => {
  // The emptiness check fires before the passphrase sanity check.
  assert.throws(() => decryptBundle('any-good-pass', ''), /empty/i);
  // 1 byte version + small body, too short to contain salt/iv/tag.
  assert.throws(
    () => decryptBundle('any-good-pass', Buffer.from([0x01, 0x00]).toString('base64')),
    /short/i,
  );
});

test('decryptBundle rejects a bundle whose schemaVersion is newer than this build', () => {
  // Hand-craft a payload that explicitly tags a higher schemaVersion; the
  // codec accepts arbitrary numbers at encrypt-time, refuses at decrypt-time.
  const futurePayload: BundlePayload = {
    ...samplePayload(),
    schemaVersion: BUNDLE_SCHEMA_VERSION + 1,
  };
  const enc = encryptBundle('any-passphrase', futurePayload);
  assert.throws(
    () => decryptBundle('any-passphrase', enc),
    /newer than supported|schemaVersion/i,
  );
});

test('encryptBundle refuses a short passphrase', () => {
  assert.throws(() => encryptBundle('short', samplePayload()), /at least 8/);
});

test('decryptBundle refuses a short passphrase', () => {
  // Even before consuming the bundle: catch UI bugs that submit a typo.
  const enc = encryptBundle('a-good-passphrase', samplePayload());
  assert.throws(() => decryptBundle('short', enc), /at least 8/);
});

test('bundleStats reports row counts + wire size', () => {
  const payload = samplePayload();
  const enc = encryptBundle('a-good-passphrase', payload);
  const stats = bundleStats(enc, payload);
  assert.equal(stats.rowCount, 3); // 1 household + 2 transactions
  assert.deepEqual(stats.tableCounts, { households: 1, transactions: 2 });
  assert.equal(stats.bytes, Buffer.byteLength(enc, 'utf8'));
});

test('round-trip preserves unicode and large rows', () => {
  const big = 'x'.repeat(50_000);
  const payload = samplePayload({
    tables: {
      contacts: [{ id: 1, name: '日本語 — café — emoji 🦊', notes: big }],
    },
  });
  const enc = encryptBundle('multi-byte-safe-passphrase', payload);
  const dec = decryptBundle('multi-byte-safe-passphrase', enc);
  const row = dec.tables.contacts?.[0] as { name: string; notes: string };
  assert.equal(row.name, '日本語 — café — emoji 🦊');
  assert.equal(row.notes, big);
});
