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

test('lookupSeedBrand matches DoorDash on glued restaurant suffixes', () => {
  assert.equal(lookupSeedBrand('DOORDASHTHESAFFRONI DOWNTOWN'), 'DoorDash');
  assert.equal(lookupSeedBrand('DOORDASHBARBURRITO DOWNTOWN'), 'DoorDash');
  assert.equal(lookupSeedBrand('DOORDASHMCDONALDS DOWNTOWN'), 'DoorDash');
  assert.equal(lookupSeedBrand('DOORDASHPOPEYESLOUI'), 'DoorDash');
});

test('lookupSeedBrand still matches plain DoorDash', () => {
  assert.equal(lookupSeedBrand('DOORDASH'), 'DoorDash');
  assert.equal(lookupSeedBrand('DD *DOORDASH'), 'DoorDash');
});
