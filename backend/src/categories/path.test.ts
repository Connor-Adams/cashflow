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
