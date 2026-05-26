import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ruleToBackfillScope } from '../src/routes/rules';

test('substring rule keeps the merchant pattern and effective dates', () => {
  const scope = ruleToBackfillScope({
    merchantPattern: 'COSTCO',
    matchKind: 'substring',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-12-31',
  });
  assert.deepEqual(scope, {
    merchantPattern: 'COSTCO',
    dateFrom: '2026-01-01',
    dateTo: '2026-12-31',
  });
});

test('regex rule drops the merchant pattern (cannot translate to SQL LIKE)', () => {
  const scope = ruleToBackfillScope({
    merchantPattern: '^AMAZON.*PRIME$',
    matchKind: 'regex',
    effectiveFrom: null,
    effectiveTo: null,
  });
  assert.equal(scope.merchantPattern, null);
});

test('empty pattern drops the filter', () => {
  const scope = ruleToBackfillScope({
    merchantPattern: '',
    matchKind: 'substring',
    effectiveFrom: null,
    effectiveTo: null,
  });
  assert.equal(scope.merchantPattern, null);
});

test('null effective dates pass through as unbounded', () => {
  const scope = ruleToBackfillScope({
    merchantPattern: 'NETFLIX',
    matchKind: 'substring',
    effectiveFrom: null,
    effectiveTo: null,
  });
  assert.equal(scope.dateFrom, null);
  assert.equal(scope.dateTo, null);
});
