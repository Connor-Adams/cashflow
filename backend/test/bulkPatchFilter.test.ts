/**
 * Unit tests for the pure cap helper that gates the filter-mode bulk patch
 * endpoint. The handler itself is exercised by the integration suite; this
 * file stays inside the lightweight `yarn test` runner so the cap rules are
 * verified without spinning up a database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BULK_PATCH_FILTER_MAX,
  enforceBulkPatchCap,
} from '../src/routes/transactions';

test('BULK_PATCH_FILTER_MAX is the documented cap value', () => {
  assert.equal(BULK_PATCH_FILTER_MAX, 1000);
});

test('enforceBulkPatchCap returns null below the cap', () => {
  assert.equal(enforceBulkPatchCap(0), null);
  assert.equal(enforceBulkPatchCap(1), null);
  assert.equal(enforceBulkPatchCap(999), null);
});

test('enforceBulkPatchCap returns null exactly at the cap', () => {
  assert.equal(enforceBulkPatchCap(1000), null);
});

test('enforceBulkPatchCap returns an overage payload above the cap', () => {
  const out = enforceBulkPatchCap(1001);
  assert.ok(out);
  assert.equal(out.matched, 1001);
  assert.equal(out.max, 1000);
  assert.match(out.error, /1001/);
  assert.match(out.error, /1000/);
});

test('enforceBulkPatchCap surfaces a very large overage by exact count', () => {
  const out = enforceBulkPatchCap(57321);
  assert.ok(out);
  assert.equal(out.matched, 57321);
  assert.equal(out.max, 1000);
});

test('enforceBulkPatchCap honours an explicit max override', () => {
  assert.equal(enforceBulkPatchCap(50, 100), null);
  const out = enforceBulkPatchCap(150, 100);
  assert.ok(out);
  assert.equal(out.matched, 150);
  assert.equal(out.max, 100);
});

test('enforceBulkPatchCap rejects negative or non-finite counts', () => {
  const a = enforceBulkPatchCap(-1);
  assert.ok(a);
  assert.equal(a.matched, 0);
  const b = enforceBulkPatchCap(Number.NaN);
  assert.ok(b);
  const c = enforceBulkPatchCap(Number.POSITIVE_INFINITY);
  assert.ok(c);
});
