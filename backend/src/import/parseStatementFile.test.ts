/**
 * Preview duplicate-detection key — dialect-stable amount normalization.
 *
 * Bug: `markDuplicates` built the lookup key for incoming rows from a JS
 * number (`String(-123.45)` → '-123.45') but the key for existing rows from
 * the model attribute. `Transaction.amount` is DECIMAL(14,4) declared as
 * string; Postgres returns numerics padded to the typmod scale
 * ('-123.4500'), so the Map lookup never matched and every transaction's
 * `duplicate` flag (and preview.duplicateCounts.transactions) was 0 in
 * production. SQLite's numeric affinity returns -123.45, which is why tests
 * passed. The key must coerce through Number() so both representations
 * collapse to the same string.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { txnDupKey } from './parseStatementFile';

const base = { date: '2026-05-01', currency: 'CAD', merchantRaw: 'PIZZAVILLE #118' };

test('pg-padded numeric string and JS number produce the same dup key', () => {
  const incoming = txnDupKey({ ...base, amount: -123.45 });
  const existingPg = txnDupKey({ ...base, amount: '-123.4500' });
  assert.equal(existingPg, incoming);
});

test('sqlite number round-trip still matches', () => {
  const incoming = txnDupKey({ ...base, amount: -123.45 });
  const existingSqlite = txnDupKey({ ...base, amount: -123.45 });
  assert.equal(existingSqlite, incoming);
});

test('unpadded string (pre-coercion call sites) matches the number form', () => {
  assert.equal(
    txnDupKey({ ...base, amount: '-123.45' }),
    txnDupKey({ ...base, amount: -123.45 }),
  );
});

test('integer amounts match their padded form', () => {
  assert.equal(
    txnDupKey({ ...base, amount: '50.0000' }),
    txnDupKey({ ...base, amount: 50 }),
  );
});

test('different amounts still produce different keys', () => {
  assert.notEqual(
    txnDupKey({ ...base, amount: '-123.4600' }),
    txnDupKey({ ...base, amount: -123.45 }),
  );
});
