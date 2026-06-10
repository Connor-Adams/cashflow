import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDateFlexible } from './parseDateFlexible';

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

test('parses two-digit-year MM/dd/yy as 20xx, not year 00xx', () => {
  const d = parseDateFlexible('03/15/25', 'MM/dd/yyyy');
  assert.ok(d);
  assert.equal(d!.getFullYear(), 2025);
  assert.equal(d!.getMonth(), 2);
  assert.equal(d!.getDate(), 15);
});

test('parses two-digit-year dd/MM/yy as 20xx', () => {
  const d = parseDateFlexible('15/03/25', 'MM/dd/yyyy');
  assert.ok(d);
  assert.equal(d!.getFullYear(), 2025);
  assert.equal(d!.getMonth(), 2);
  assert.equal(d!.getDate(), 15);
});

test('parses two-digit-year dd.MM.yy as 20xx', () => {
  const d = parseDateFlexible('15.03.25');
  assert.ok(d);
  assert.equal(d!.getFullYear(), 2025);
  assert.equal(d!.getMonth(), 2);
  assert.equal(d!.getDate(), 15);
});

test('UTC-suffixed ISO datetime keeps the literal calendar date', () => {
  const d = parseDateFlexible('2025-01-05T00:00:00Z', 'MM/dd/yyyy');
  assert.ok(d);
  assert.equal(d!.getFullYear(), 2025);
  assert.equal(d!.getMonth(), 0);
  assert.equal(d!.getDate(), 5);
});

test('offset ISO datetime keeps the literal calendar date', () => {
  const d = parseDateFlexible('2025-01-05T23:30:00-08:00', 'MM/dd/yyyy');
  assert.ok(d);
  assert.equal(d!.getFullYear(), 2025);
  assert.equal(d!.getMonth(), 0);
  assert.equal(d!.getDate(), 5);
});

test('returns null for unparseable input', () => {
  assert.equal(parseDateFlexible('not a date'), null);
});
