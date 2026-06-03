import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  itemMeetsBar,
  transactionClearsFromItems,
  type ItemClearInput,
} from '../src/import/enrichment/transactionClearsFromItems';

const T = 80;
function item(p: Partial<ItemClearInput>): ItemClearInput {
  return { inferredCategory: null, categoryOverride: null, confidence: null, ...p };
}

test('high-confidence AI item meets the bar', () => {
  assert.equal(itemMeetsBar(item({ inferredCategory: 'Groceries', confidence: 95 }), T), true);
});

test('low-confidence AI item fails the bar', () => {
  assert.equal(itemMeetsBar(item({ inferredCategory: 'Groceries', confidence: 40 }), T), false);
});

test('confidence exactly at threshold meets the bar', () => {
  assert.equal(itemMeetsBar(item({ inferredCategory: 'X', confidence: 80 }), T), true);
});

test('null confidence fails the bar even with a category', () => {
  assert.equal(itemMeetsBar(item({ inferredCategory: 'X', confidence: null }), T), false);
});

test('user override counts regardless of confidence', () => {
  assert.equal(itemMeetsBar(item({ categoryOverride: 'Household', confidence: 10 }), T), true);
});

test('all items high-confidence => transaction clears', () => {
  const items = [
    item({ inferredCategory: 'A', confidence: 90 }),
    item({ categoryOverride: 'B' }),
  ];
  assert.equal(transactionClearsFromItems(items, T), true);
});

test('one straggler => transaction does not clear', () => {
  const items = [
    item({ inferredCategory: 'A', confidence: 90 }),
    item({ inferredCategory: 'B', confidence: 30 }),
  ];
  assert.equal(transactionClearsFromItems(items, T), false);
});

test('zero items => does not clear (fall back to normal logic)', () => {
  assert.equal(transactionClearsFromItems([], T), false);
});
