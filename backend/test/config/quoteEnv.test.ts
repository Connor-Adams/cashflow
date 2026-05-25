/**
 * Unit tests for the quote-scheduler env parsers.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let parseQuoteSchedulerEnabled: typeof import('../../src/config/env.js').parseQuoteSchedulerEnabled;
let parseQuoteDailyBudget: typeof import('../../src/config/env.js').parseQuoteDailyBudget;
let parseQuoteMinAgeHours: typeof import('../../src/config/env.js').parseQuoteMinAgeHours;

before(async () => {
  const envModule = await import('../../src/config/env.js');
  parseQuoteSchedulerEnabled = envModule.parseQuoteSchedulerEnabled;
  parseQuoteDailyBudget = envModule.parseQuoteDailyBudget;
  parseQuoteMinAgeHours = envModule.parseQuoteMinAgeHours;
});

test('parseQuoteSchedulerEnabled: explicit true/false wins', () => {
  assert.equal(parseQuoteSchedulerEnabled('true', 'production', 'key'), true);
  assert.equal(parseQuoteSchedulerEnabled('false', 'production', 'key'), false);
  assert.equal(parseQuoteSchedulerEnabled('1', 'production', null), true);
  assert.equal(parseQuoteSchedulerEnabled('0', 'production', 'key'), false);
});

test('parseQuoteSchedulerEnabled: defaults to false in test env', () => {
  assert.equal(parseQuoteSchedulerEnabled(undefined, 'test', 'key'), false);
});

test('parseQuoteSchedulerEnabled: defaults to true in non-test when key present', () => {
  assert.equal(parseQuoteSchedulerEnabled(undefined, 'production', 'key'), true);
  assert.equal(parseQuoteSchedulerEnabled(undefined, 'development', 'key'), true);
});

test('parseQuoteSchedulerEnabled: defaults to false when key absent', () => {
  assert.equal(parseQuoteSchedulerEnabled(undefined, 'production', null), false);
});

test('parseQuoteDailyBudget: defaults to 22 and rejects out-of-range', () => {
  assert.equal(parseQuoteDailyBudget(undefined), 22);
  assert.equal(parseQuoteDailyBudget(''), 22);
  assert.equal(parseQuoteDailyBudget('10'), 10);
  assert.throws(() => parseQuoteDailyBudget('0'));
  assert.throws(() => parseQuoteDailyBudget('26'));
  assert.throws(() => parseQuoteDailyBudget('abc'));
});

test('parseQuoteMinAgeHours: defaults to 18 and rejects out-of-range', () => {
  assert.equal(parseQuoteMinAgeHours(undefined), 18);
  assert.equal(parseQuoteMinAgeHours(''), 18);
  assert.equal(parseQuoteMinAgeHours('0'), 0);
  assert.equal(parseQuoteMinAgeHours('12.5'), 12.5);
  assert.throws(() => parseQuoteMinAgeHours('-1'));
  assert.throws(() => parseQuoteMinAgeHours('999'));
});
