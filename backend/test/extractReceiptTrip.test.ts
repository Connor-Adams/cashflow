import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExtractedReceipt } from '../src/ai/extractReceiptItems';

test('parseExtractedReceipt reads an optional trip block', () => {
  const order = parseExtractedReceipt({
    vendor: 'uber',
    total: 23.45,
    items: [],
    trip: {
      pickupAddress: '123 Main St',
      dropoffAddress: '456 King St W',
      distance: 12.3,
      distanceUnit: 'km',
      durationMinutes: 27,
      requestedAt: '2026-03-03T09:14:00Z',
      driver: 'Sam',
      surgeMultiplier: 1.2,
    },
  });
  assert.equal(order.trip?.distance, 12.3);
  assert.equal(order.trip?.distanceUnit, 'km');
  assert.equal(order.trip?.dropoffAddress, '456 King St W');
});

test('parseExtractedReceipt defaults trip to null', () => {
  const order = parseExtractedReceipt({ vendor: 'other', total: 5, items: [] });
  assert.equal(order.trip ?? null, null);
});
