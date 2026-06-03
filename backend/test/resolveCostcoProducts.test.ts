import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  itemNumbersMatch,
  pickVerifiedProduct,
  RESOLVE_VENDORS,
} from '../src/import/enrichment/resolveCostcoProducts';
import type { CostcoProductData } from '../src/integrations/costco/scraperClient';

test('RESOLVE_VENDORS is costco only', () => {
  assert.deepEqual(RESOLVE_VENDORS, ['costco']);
});

test('itemNumbersMatch compares digits-only, ignoring leading zeros and formatting', () => {
  assert.equal(itemNumbersMatch('1011242', '1011242'), true);
  assert.equal(itemNumbersMatch('0001011242', '1011242'), true);
  assert.equal(itemNumbersMatch('1011242', 'Item# 1011242'), true);
  assert.equal(itemNumbersMatch('1011242', '9999999'), false);
  assert.equal(itemNumbersMatch(null, '1011242'), false);
  assert.equal(itemNumbersMatch('1011242', null), false);
  assert.equal(itemNumbersMatch('', ''), false);
});

test('pickVerifiedProduct returns the candidate whose item number matches the receipt', () => {
  const candidates: CostcoProductData[] = [
    { itemNumber: '9999999', title: 'Wrong', imageUrl: 'a', url: 'u1', price: 1 },
    { itemNumber: '1011242', title: 'Right', imageUrl: 'b', url: 'u2', price: 2 },
  ];
  const hit = pickVerifiedProduct('1011242', candidates);
  assert.equal(hit?.url, 'u2');
});

test('pickVerifiedProduct returns null when no candidate matches', () => {
  const candidates: CostcoProductData[] = [
    { itemNumber: '9999999', title: 'Wrong', imageUrl: 'a', url: 'u1', price: 1 },
  ];
  assert.equal(pickVerifiedProduct('1011242', candidates), null);
});

test('pickVerifiedProduct returns null on empty candidate list', () => {
  assert.equal(pickVerifiedProduct('1011242', []), null);
});
