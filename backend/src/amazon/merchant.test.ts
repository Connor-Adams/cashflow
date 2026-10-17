import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAmazonLikeMerchant, isAmazonSubscriptionCharge } from './merchant';

test('isAmazonLikeMerchant: positive cases', () => {
  assert.equal(isAmazonLikeMerchant('AMZN MKTP CA'), true);
  assert.equal(isAmazonLikeMerchant('Amazon.ca'), true);
  assert.equal(isAmazonLikeMerchant('AMAZON MARKETPLACE'), true);
  assert.equal(isAmazonLikeMerchant('amzn mktp ca *abc'), true);
  assert.equal(isAmazonLikeMerchant('Prime Video'), true);
});

test('isAmazonLikeMerchant: PRIMERICA does NOT match (word boundary on \\bprime\\b)', () => {
  assert.equal(isAmazonLikeMerchant('PRIMERICA INSURANCE'), false);
  assert.equal(isAmazonLikeMerchant('Cafe Primo'), false);
  assert.equal(isAmazonLikeMerchant('Costco Wholesale'), false);
});

// ─── Task 17: Prime membership charge filtering ────────────────────────────
// The annual Prime membership charge ($111.87) is a subscription, never an order,
// and can never match. Prime Video rentals ARE orders and must keep matching.
// isAmazonSubscriptionCharge is separate from isAmazonLikeMerchant because the
// latter drives scoring bonuses and backfill selection — narrowing it would
// silently change those side effects.

test('the annual Prime membership charge is a subscription, not an order', () => {
  assert.equal(isAmazonSubscriptionCharge('AMAZON.CA PRIME MEMBER'), true);
  assert.equal(isAmazonSubscriptionCharge('Amazon.ca Prime Member'), true);
});

test('Prime Video rentals are orders and are NOT filtered', () => {
  assert.equal(isAmazonSubscriptionCharge('AMAZON PRIME VIDEO'), false);
  assert.equal(isAmazonSubscriptionCharge('AMZN MKTP CA*Z90R91K22'), false);
});

test('isAmazonLikeMerchant is unchanged — it still matches Prime generally', () => {
  assert.equal(isAmazonLikeMerchant('AMAZON.CA PRIME MEMBER'), true);
  assert.equal(isAmazonLikeMerchant('AMAZON PRIME VIDEO'), true);
});
