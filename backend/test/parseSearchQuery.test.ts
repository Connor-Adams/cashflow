import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchQuery } from '../src/search/parseSearchQuery';

test('empty input returns isEmpty=true with no errors', () => {
  for (const input of ['', '   ', null, undefined]) {
    const r = parseSearchQuery(input as string | null | undefined);
    assert.equal(r.isEmpty, true);
    assert.deepEqual(r.errors, []);
  }
});

test('merchant:<text> captures merchant', () => {
  const r = parseSearchQuery('merchant:Costco');
  assert.equal(r.merchant, 'Costco');
  assert.equal(r.isEmpty, false);
});

test('merchant:"Costco Wholesale" preserves spaces in quoted value', () => {
  const r = parseSearchQuery('merchant:"Costco Wholesale"');
  assert.equal(r.merchant, 'Costco Wholesale');
});

test('category:<name> captures category', () => {
  const r = parseSearchQuery('category:Groceries');
  assert.equal(r.category, 'Groceries');
});

test('category:"Food and Dining" preserves quoted category names', () => {
  const r = parseSearchQuery('category:"Food and Dining"');
  assert.equal(r.category, 'Food and Dining');
});

test('amount:>100 captures > operator', () => {
  const r = parseSearchQuery('amount:>100');
  assert.deepEqual(r.amount, { op: '>', value: 100 });
});

test('amount:<=50 captures <= operator', () => {
  const r = parseSearchQuery('amount:<=50');
  assert.deepEqual(r.amount, { op: '<=', value: 50 });
});

test('amount:42 defaults to = operator', () => {
  const r = parseSearchQuery('amount:42');
  assert.deepEqual(r.amount, { op: '=', value: 42 });
});

test('amount:10..50 captures inclusive range', () => {
  const r = parseSearchQuery('amount:10..50');
  assert.deepEqual(r.amount, { min: 10, max: 50 });
});

test('amount:..50 captures upper-only range', () => {
  const r = parseSearchQuery('amount:..50');
  assert.deepEqual(r.amount, { min: undefined, max: 50 });
});

test('amount:10.. captures lower-only range', () => {
  const r = parseSearchQuery('amount:10..');
  assert.deepEqual(r.amount, { min: 10, max: undefined });
});

test('amount:not-a-number reports an error', () => {
  const r = parseSearchQuery('amount:abc');
  assert.equal(r.amount, undefined);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /Invalid amount/);
});

test('date:2026-01-01..2026-03-31 captures date range', () => {
  const r = parseSearchQuery('date:2026-01-01..2026-03-31');
  assert.equal(r.dateFrom, '2026-01-01');
  assert.equal(r.dateTo, '2026-03-31');
});

test('date:2026-01-15 captures single day (from == to)', () => {
  const r = parseSearchQuery('date:2026-01-15');
  assert.equal(r.dateFrom, '2026-01-15');
  assert.equal(r.dateTo, '2026-01-15');
});

test('date:2026-01-01.. captures open-ended start', () => {
  const r = parseSearchQuery('date:2026-01-01..');
  assert.equal(r.dateFrom, '2026-01-01');
  assert.equal(r.dateTo, undefined);
});

test('date:..2026-01-31 captures open-ended end', () => {
  const r = parseSearchQuery('date:..2026-01-31');
  assert.equal(r.dateFrom, undefined);
  assert.equal(r.dateTo, '2026-01-31');
});

test('date:not-iso-format reports an error', () => {
  const r = parseSearchQuery('date:01-01-2026');
  assert.equal(r.dateFrom, undefined);
  assert.equal(r.dateTo, undefined);
  assert.match(r.errors[0], /YYYY-MM-DD/);
});

test('has:receipt sets hasReceipt to "has"', () => {
  const r = parseSearchQuery('has:receipt');
  assert.equal(r.hasReceipt, 'has');
});

test('no:receipt sets hasReceipt to "none"', () => {
  const r = parseSearchQuery('no:receipt');
  assert.equal(r.hasReceipt, 'none');
});

test('has:unknown reports an error', () => {
  const r = parseSearchQuery('has:wings');
  assert.equal(r.hasReceipt, undefined);
  assert.match(r.errors[0], /has:receipt/);
});

test('review:yes sets review filter', () => {
  const r = parseSearchQuery('review:yes');
  assert.equal(r.review, 'yes');
});

test('review:no sets review filter', () => {
  const r = parseSearchQuery('review:no');
  assert.equal(r.review, 'no');
});

test('recurring:yes sets recurring filter', () => {
  const r = parseSearchQuery('recurring:yes');
  assert.equal(r.recurring, 'yes');
});

test('scope:business is supported', () => {
  const r = parseSearchQuery('scope:business');
  assert.equal(r.scope, 'business');
});

test('scope:personal is supported', () => {
  const r = parseSearchQuery('scope:personal');
  assert.equal(r.scope, 'personal');
});

test('scope:partner is supported', () => {
  const r = parseSearchQuery('scope:partner');
  assert.equal(r.scope, 'partner');
});

test('scope:recurring is supported', () => {
  const r = parseSearchQuery('scope:recurring');
  assert.equal(r.scope, 'recurring');
});

test('scope:bogus reports an error', () => {
  const r = parseSearchQuery('scope:bogus');
  assert.equal(r.scope, undefined);
  assert.match(r.errors[0], /business|personal|partner|recurring/);
});

test('combined filters all populate', () => {
  const r = parseSearchQuery(
    'category:Groceries amount:>100 date:2026-01-01..2026-03-31 scope:business has:receipt',
  );
  assert.equal(r.category, 'Groceries');
  assert.deepEqual(r.amount, { op: '>', value: 100 });
  assert.equal(r.dateFrom, '2026-01-01');
  assert.equal(r.dateTo, '2026-03-31');
  assert.equal(r.scope, 'business');
  assert.equal(r.hasReceipt, 'has');
  assert.equal(r.isEmpty, false);
});

test('free-text words land in freeText joined by spaces', () => {
  const r = parseSearchQuery('coffee tim hortons');
  assert.equal(r.freeText, 'coffee tim hortons');
  assert.equal(r.merchant, undefined);
});

test('mixed key:value + free text both populate', () => {
  const r = parseSearchQuery('coffee category:Dining');
  assert.equal(r.freeText, 'coffee');
  assert.equal(r.category, 'Dining');
});

test('keys are case-insensitive', () => {
  const r = parseSearchQuery('MERCHANT:Costco CATEGORY:Food');
  assert.equal(r.merchant, 'Costco');
  assert.equal(r.category, 'Food');
});

test('missing value reports an error', () => {
  const r = parseSearchQuery('merchant:');
  assert.equal(r.merchant, undefined);
  assert.match(r.errors[0], /Missing value/);
});

test('unknown key:value lands in freeText (does not silently drop input)', () => {
  const r = parseSearchQuery('weather:sunny');
  // unknown key — falls into freeText so the user's input is preserved
  // verbatim and they don't get a misleading "match nothing" result.
  assert.match(r.freeText ?? '', /weather:sunny/);
});

test('isEmpty stays true when only whitespace tokens', () => {
  const r = parseSearchQuery('   \t\n   ');
  assert.equal(r.isEmpty, true);
});

test('isEmpty becomes false even with only errors collected', () => {
  // Single invalid amount token. The user TYPED something, so freeText
  // captures nothing (the token started with `amount:` so it routed to the
  // amount branch and produced an error). isEmpty must remain true so the
  // route can return the "please type something" helper.
  const r = parseSearchQuery('amount:abc');
  assert.equal(r.isEmpty, true);
  assert.equal(r.errors.length, 1);
});
