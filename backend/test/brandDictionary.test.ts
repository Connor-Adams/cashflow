import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lookupSeedBrand,
  type BrandEntry,
} from '../src/import/enrichment/brandDictionary';

test('lookupSeedBrand returns Amazon for AMZN MKTP variants', () => {
  assert.equal(lookupSeedBrand('AMZN MKTP US A1B2C3'), 'Amazon');
  assert.equal(lookupSeedBrand('amazon.ca prime'), 'Amazon');
  assert.equal(lookupSeedBrand('AMZN Digital Svcs'), 'Amazon');
});

test('lookupSeedBrand returns Netflix for Netflix variants', () => {
  assert.equal(lookupSeedBrand('NETFLIX.COM'), 'Netflix');
  assert.equal(lookupSeedBrand('netflix monthly'), 'Netflix');
});

test('lookupSeedBrand returns null for unknown', () => {
  assert.equal(lookupSeedBrand("Joe's Coffee Shop"), null);
  assert.equal(lookupSeedBrand(''), null);
});

test('lookupSeedBrand normalizes case', () => {
  assert.equal(lookupSeedBrand('SPOTIFY'), 'Spotify');
  assert.equal(lookupSeedBrand('spotify usa'), 'Spotify');
});
