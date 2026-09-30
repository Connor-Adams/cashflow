import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryLeafSegment, parseCategoryPath } from './path';

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

// ---------------------------------------------------------------------------
// categoryLeafSegment — the fallback every static category writer uses when
// nothing resolved. Unlike parseCategoryPath it must NEVER throw: it runs inside
// fire-and-forget enrichment writers, and a throw there would fail the batch.
// ---------------------------------------------------------------------------

test('categoryLeafSegment: a flat name is its own leaf', () => {
  assert.equal(categoryLeafSegment('Rent'), 'Rent');
  assert.equal(categoryLeafSegment('  Rent  '), 'Rent', 'segments are trimmed');
});

test('categoryLeafSegment: a path form degrades to its LAST segment', () => {
  // This is the whole point: "Household / Rent" in final_category matches no
  // budget, because every budget and spend rollup joins that column exactly.
  assert.equal(categoryLeafSegment('Household / Rent'), 'Rent');
  assert.equal(categoryLeafSegment('A / B / C'), 'C');
});

test('categoryLeafSegment: empty segments are SKIPPED, not rejected', () => {
  // Each of these makes parseCategoryPath throw; here they must resolve quietly.
  assert.equal(categoryLeafSegment('Household // Rent'), 'Rent');
  assert.equal(categoryLeafSegment('Rent/'), 'Rent');
  assert.equal(categoryLeafSegment('/Rent'), 'Rent');
  assert.equal(categoryLeafSegment('Household / / Rent'), 'Rent');
});

test('categoryLeafSegment: null when there is no non-empty segment at all', () => {
  assert.equal(categoryLeafSegment('///'), null, 'separators only');
  assert.equal(categoryLeafSegment(''), null);
  assert.equal(categoryLeafSegment('   '), null);
  assert.equal(categoryLeafSegment(null), null);
  assert.equal(categoryLeafSegment(undefined), null);
});

test('categoryLeafSegment: a repeated-name path still yields the last segment', () => {
  // parseCategoryPath accepts these and resolveCategoryPath truncates at the
  // repetition; the fallback makes no such judgement, it just takes the leaf.
  assert.equal(categoryLeafSegment('Food / Food'), 'Food');
  assert.equal(categoryLeafSegment('Food / Bar / Food'), 'Food');
});
