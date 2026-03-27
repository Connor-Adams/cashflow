import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDateFlexible } from '../src/import/parseDateFlexible';

test('parses US Amex MM/dd/yyyy', () => {
  const d = parseDateFlexible('03/15/2025', 'MM/dd/yyyy');
  assert.ok(d);
  assert.equal(d!.getFullYear(), 2025);
  assert.equal(d!.getMonth(), 2);
  assert.equal(d!.getDate(), 15);
});

test('parses CA style dd/MM/yyyy', () => {
  const d = parseDateFlexible('15/03/2025', 'MM/dd/yyyy');
  assert.ok(d);
  assert.equal(d!.getFullYear(), 2025);
  assert.equal(d!.getMonth(), 2);
  assert.equal(d!.getDate(), 15);
});

test('parses ISO yyyy-MM-dd', () => {
  const d = parseDateFlexible('2025-03-15', 'MM/dd/yyyy');
  assert.ok(d);
  assert.equal(d!.getMonth(), 2);
  assert.equal(d!.getDate(), 15);
});
