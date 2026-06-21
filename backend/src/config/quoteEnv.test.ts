/**
 * Unit tests for the quote-scheduler env parsers.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let parseQuoteSchedulerEnabled: typeof import('./env.js').parseQuoteSchedulerEnabled;
let parseQuoteMinAgeHours: typeof import('./env.js').parseQuoteMinAgeHours;

before(async () => {
  const envModule = await import('./env.js');
  parseQuoteSchedulerEnabled = envModule.parseQuoteSchedulerEnabled;
  parseQuoteMinAgeHours = envModule.parseQuoteMinAgeHours;
});

test('parseQuoteSchedulerEnabled: explicit true/false wins', () => {
  assert.equal(parseQuoteSchedulerEnabled('true', 'production'), true);
  assert.equal(parseQuoteSchedulerEnabled('false', 'production'), false);
  assert.equal(parseQuoteSchedulerEnabled('1', 'production'), true);
  assert.equal(parseQuoteSchedulerEnabled('0', 'production'), false);
});

test('parseQuoteSchedulerEnabled: defaults to false in test env', () => {
  assert.equal(parseQuoteSchedulerEnabled(undefined, 'test'), false);
});

test('parseQuoteSchedulerEnabled: defaults to true in non-test', () => {
  assert.equal(parseQuoteSchedulerEnabled(undefined, 'production'), true);
  assert.equal(parseQuoteSchedulerEnabled(undefined, 'development'), true);
});

test('parseQuoteMinAgeHours: defaults to 18 and rejects out-of-range', () => {
  assert.equal(parseQuoteMinAgeHours(undefined), 18);
  assert.equal(parseQuoteMinAgeHours(''), 18);
  assert.equal(parseQuoteMinAgeHours('0'), 0);
  assert.equal(parseQuoteMinAgeHours('12.5'), 12.5);
  assert.throws(() => parseQuoteMinAgeHours('-1'));
  assert.throws(() => parseQuoteMinAgeHours('999'));
});
