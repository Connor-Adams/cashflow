import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferDateOrdering, parseDateFlexible } from './parseDateFlexible';

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

test('ambiguous dash dates default month-first, consistent with slash dates', () => {
  const slash = parseDateFlexible('12/05/2025');
  const dash = parseDateFlexible('12-05-2025');
  assert.ok(slash && dash);
  // Both resolve as Dec 5, not one Dec 5 and the other May 12.
  assert.equal(slash!.getMonth(), 11);
  assert.equal(slash!.getDate(), 5);
  assert.equal(dash!.getMonth(), 11);
  assert.equal(dash!.getDate(), 5);
});

test('day-first ordering resolves ambiguous slash dates as dd/MM', () => {
  const d = parseDateFlexible('03/04/2025', undefined, 'day-first');
  assert.ok(d);
  assert.equal(d!.getMonth(), 3); // April
  assert.equal(d!.getDate(), 3);
});

test('day-first ordering resolves ambiguous dash dates as dd-MM', () => {
  const d = parseDateFlexible('03-04-2025', undefined, 'day-first');
  assert.ok(d);
  assert.equal(d!.getMonth(), 3); // April
  assert.equal(d!.getDate(), 3);
});

test('month-first ordering resolves ambiguous slash dates as MM/dd', () => {
  const d = parseDateFlexible('03/04/2025', undefined, 'month-first');
  assert.ok(d);
  assert.equal(d!.getMonth(), 2); // March
  assert.equal(d!.getDate(), 4);
});

test('preferred format outranks inferred ordering', () => {
  const d = parseDateFlexible('03/04/2025', 'MM/dd/yyyy', 'day-first');
  assert.ok(d);
  assert.equal(d!.getMonth(), 2); // March
  assert.equal(d!.getDate(), 4);
});

test('inferDateOrdering detects day-first from an unambiguous token', () => {
  assert.equal(
    inferDateOrdering(['03/04/2025', '15/03/2025', '']),
    'day-first'
  );
});

test('inferDateOrdering detects month-first from an unambiguous token', () => {
  assert.equal(
    inferDateOrdering(['03/15/2025', '03/04/2025']),
    'month-first'
  );
});

test('inferDateOrdering returns null without unambiguous tokens', () => {
  assert.equal(
    inferDateOrdering(['03/04/2025', '2025-01-01', null, undefined]),
    null
  );
});

test('inferDateOrdering returns null on conflicting evidence', () => {
  assert.equal(inferDateOrdering(['15/03/2025', '03/15/2025']), null);
});
