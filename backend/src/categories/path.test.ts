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

test('a repeated segment name parses: this is a pure parser, not a validator', () => {
  // A repeated name is handled by resolveCategoryPath, which TRUNCATES the path
  // at the repetition (a name denotes one household node, so the repeat adds no
  // information). Rejecting here would 400 "Food / Food", which the UI's own
  // tree flattener hands the user whenever a child shares its parent's name.
  assert.deepEqual(parseCategoryPath('Food / Food'), ['Food', 'Food']);
  assert.deepEqual(parseCategoryPath('Food / Bar / Food'), ['Food', 'Bar', 'Food']);
  assert.deepEqual(parseCategoryPath('Food / bar / FOOD'), ['Food', 'bar', 'FOOD']);
});

test('distinct segments that merely share a prefix are still accepted', () => {
  assert.deepEqual(parseCategoryPath('Food / Food Delivery'), ['Food', 'Food Delivery']);
});

test('the rejection message stays exactly "invalid category path" (both callers compare it with ===)', () => {
  // util/ensureCategory.ts swallows this message so a bad enrichment mirror name
  // cannot fail the batch; routes/categories.ts POST /resolve-path maps it to a
  // 400. Decorating the message would turn those into a thrown batch and a 500.
  assert.throws(
    () => parseCategoryPath('Work//Internet'),
    (err: Error) => {
      assert.equal(err.message, 'invalid category path');
      return true;
    },
  );
});
