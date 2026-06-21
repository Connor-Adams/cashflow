import { test } from 'vitest';
import { expect } from 'vitest';
import { enrichmentFilterHref } from './enrichmentFilterHref';

test('encodes value', () => {
  expect(enrichmentFilterHref('autoConfidence', 'low')).toBe('/transactions?autoConfidence=low');
});
test('passes (none) through', () => {
  expect(enrichmentFilterHref('autoSource', '(none)')).toBe('/transactions?autoSource=%28none%29');
});
test('encodes spaces in merchant', () => {
  expect(enrichmentFilterHref('merchantCanonical', 'Whole Foods'))
    .toBe('/transactions?merchantCanonical=Whole+Foods');
});
