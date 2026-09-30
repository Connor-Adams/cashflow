import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCategoryPath } from './path';

test('splits and trims segments', () => {
  assert.deepEqual(parseCategoryPath('Work / Expenses / Internet'), ['Work', 'Expenses', 'Internet']);
  assert.deepEqual(parseCategoryPath(' Work / Internet '), ['Work', 'Internet']);
});

test('bare name is a single root segment', () => {
  assert.deepEqual(parseCategoryPath('Internet'), ['Internet']);
});

test('rejects empty segments', () => {
  assert.throws(() => parseCategoryPath('Work//Internet'), /invalid category path/);
  assert.throws(() => parseCategoryPath('Work /'), /invalid category path/);
  assert.throws(() => parseCategoryPath('  '), /invalid category path/);
});

test('rejects a path that repeats a segment name', () => {
  // A name denotes one node per household, so the same name cannot be two
  // different nodes on one path. Unrejected, resolveCategoryPath returned a leaf
  // that was an ancestor of a node the same call had just created.
  assert.throws(() => parseCategoryPath('Food / Bar / Food'), /invalid category path/);
  assert.throws(() => parseCategoryPath('Food / Food'), /invalid category path/);
});

test('repeated-segment rejection uses the name_key normalizer, so case and spacing do not evade it', () => {
  assert.throws(() => parseCategoryPath('Food / bar / FOOD'), /invalid category path/);
  assert.throws(() => parseCategoryPath('Food /   food  '), /invalid category path/);
});

test('distinct segments that merely share a prefix are still accepted', () => {
  assert.deepEqual(parseCategoryPath('Food / Food Delivery'), ['Food', 'Food Delivery']);
});

test('the rejection message stays exactly "invalid category path" (both callers compare it with ===)', () => {
  // util/ensureCategory.ts swallows this message so a bad enrichment mirror name
  // cannot fail the batch; routes/categories.ts POST /resolve-path maps it to a
  // 400. Decorating the message would turn those into a thrown batch and a 500.
  assert.throws(
    () => parseCategoryPath('Food / Bar / Food'),
    (err: Error & { repeatedSegment?: string }) => {
      assert.equal(err.message, 'invalid category path');
      assert.equal(err.repeatedSegment, 'Food');
      return true;
    },
  );
});
