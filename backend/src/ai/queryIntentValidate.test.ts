/**
 * Pure-function unit tests for the natural-language query intent validator.
 *
 * The validator is the defense-in-depth boundary between the AI (untrusted —
 * may emit anything) and the audited query builders. Every field on every
 * intent must be on a known whitelist; unknown intent names, unknown filter
 * fields, and out-of-shape values must all be rejected with a clear error
 * message that the route can return to the client.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateIntent,
  SUPPORTED_INTENTS,
  type QueryIntent,
} from './queryIntents.js';

test('SUPPORTED_INTENTS lists exactly the five supported intent names', () => {
  assert.deepEqual([...SUPPORTED_INTENTS].sort(), [
    'comparison',
    'partner_balance',
    'subscription_increase_check',
    'transaction_search',
    'transaction_summary',
  ]);
});

test('validateIntent rejects non-object input', () => {
  for (const value of [null, undefined, 'string', 42, true, []]) {
    const r = validateIntent(value as unknown);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /must be an object/i);
  }
});

test('validateIntent rejects missing intent field', () => {
  const r = validateIntent({});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /intent is required/i);
});

test('validateIntent rejects unsupported intent name with a clear message', () => {
  const r = validateIntent({ intent: 'drop_database', filters: {} });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /intent .* not supported/i);
    assert.match(r.error, /drop_database/);
  }
});

test('validateIntent rejects unknown filter fields on transaction_summary', () => {
  const r = validateIntent({
    intent: 'transaction_summary',
    filters: { rawSql: "DROP TABLE transactions" },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /unknown filter field/i);
});

test('validateIntent rejects bogus dateRange enum', () => {
  const r = validateIntent({
    intent: 'transaction_summary',
    filters: { dateRange: 'forever_ago' },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /dateRange/i);
});

test('validateIntent rejects bogus scope value', () => {
  const r = validateIntent({
    intent: 'transaction_summary',
    filters: { scope: 'admin' },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /scope/i);
});

test('validateIntent rejects bogus groupBy on transaction_summary', () => {
  const r = validateIntent({
    intent: 'transaction_summary',
    filters: {},
    groupBy: 'password',
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /groupBy/i);
});

test('validateIntent accepts a well-formed transaction_summary intent', () => {
  const r = validateIntent({
    intent: 'transaction_summary',
    filters: {
      category: 'Restaurants',
      dateRange: 'last_month',
      scope: 'personal',
    },
    groupBy: 'category',
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    const intent = r.intent as Extract<QueryIntent, { intent: 'transaction_summary' }>;
    assert.equal(intent.intent, 'transaction_summary');
    assert.equal(intent.filters.category, 'Restaurants');
    assert.equal(intent.filters.dateRange, 'last_month');
    assert.equal(intent.filters.scope, 'personal');
    assert.equal(intent.groupBy, 'category');
  }
});

test('validateIntent accepts explicit dateFrom/dateTo and rejects malformed ISO', () => {
  const okR = validateIntent({
    intent: 'transaction_summary',
    filters: { dateFrom: '2026-01-01', dateTo: '2026-01-31' },
  });
  assert.equal(okR.ok, true);

  const badR = validateIntent({
    intent: 'transaction_summary',
    filters: { dateFrom: '2026-13-99' },
  });
  assert.equal(badR.ok, false);
  if (!badR.ok) assert.match(badR.error, /dateFrom/i);
});

test('validateIntent rejects business filter when not boolean', () => {
  const r = validateIntent({
    intent: 'transaction_search',
    filters: { business: 'yes please' },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /business/i);
});

test('validateIntent accepts transaction_search with missingReceipt filter', () => {
  const r = validateIntent({
    intent: 'transaction_search',
    filters: { business: true, missingReceipt: true, dateRange: 'this_month' },
  });
  assert.equal(r.ok, true);
});

test('validateIntent rejects comparison without two periods', () => {
  const r = validateIntent({
    intent: 'comparison',
    filters: { dateRange: 'last_month' },
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    // The intent envelope-key check fires first for `filters` not being on the
    // comparison whitelist — comparison takes periodA/periodB. Whichever
    // rejection fires first, it should mention one of the period fields.
    assert.match(r.error, /periodA|periodB/i);
  }
});

test('validateIntent accepts comparison with periodA + periodB enums', () => {
  const r = validateIntent({
    intent: 'comparison',
    periodA: 'last_month',
    periodB: 'this_month',
    filters: { category: 'Restaurants' },
  });
  assert.equal(r.ok, true);
});

test('validateIntent rejects unsupported period for comparison', () => {
  const r = validateIntent({
    intent: 'comparison',
    periodA: 'random_period',
    periodB: 'this_month',
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /periodA/i);
});

test('validateIntent accepts subscription_increase_check with windowMonths', () => {
  const r = validateIntent({
    intent: 'subscription_increase_check',
    windowMonths: 6,
  });
  assert.equal(r.ok, true);
});

test('validateIntent clamps windowMonths to a reasonable range', () => {
  const tooBig = validateIntent({
    intent: 'subscription_increase_check',
    windowMonths: 9999,
  });
  // Either reject or clamp — both are safe. We require validation
  // to refuse values that exceed the documented max so the model
  // gets clear feedback.
  assert.equal(tooBig.ok, false);

  const tooSmall = validateIntent({
    intent: 'subscription_increase_check',
    windowMonths: 0,
  });
  assert.equal(tooSmall.ok, false);
});

test('validateIntent accepts partner_balance with no extra fields', () => {
  const r = validateIntent({ intent: 'partner_balance' });
  assert.equal(r.ok, true);
});

test('validateIntent rejects partner_balance with stray fields (defense in depth)', () => {
  const r = validateIntent({
    intent: 'partner_balance',
    filters: { rawHousehold: 99 },
  });
  assert.equal(r.ok, false);
});

test('validateIntent rejects category that is not a string', () => {
  const r = validateIntent({
    intent: 'transaction_summary',
    filters: { category: { evil: true } },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /category/i);
});

test('validateIntent rejects oversized category strings', () => {
  const r = validateIntent({
    intent: 'transaction_summary',
    filters: { category: 'x'.repeat(256) },
  });
  assert.equal(r.ok, false);
});

test('validateIntent rejects unknown top-level fields on the intent envelope', () => {
  const r = validateIntent({
    intent: 'transaction_summary',
    filters: {},
    secret: 'leak everything',
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /unknown field/i);
});

test('validateIntent rejects unknown groupBy enum on transaction_search', () => {
  const r = validateIntent({
    intent: 'transaction_search',
    filters: {},
    groupBy: 'category',
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /transaction_search.*does not support groupBy|groupBy/i);
});
