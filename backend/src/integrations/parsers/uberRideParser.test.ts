import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUberRide } from './uber';

const RIDE_BODY = [
  'Thanks for riding, Connor',
  'Total $23.45',
  'March 3, 2026',
  '9:14 AM  123 Main St, Toronto',
  '9:41 AM  456 King St W, Toronto',
  '12.3 km | 27 min',
].join('\n');

test('parseUberRide extracts fare, distance, duration, addresses', () => {
  const order = parseUberRide(RIDE_BODY);
  assert.ok(order);
  assert.equal(order!.vendor, 'uber');
  assert.equal(order!.total, 23.45);
  assert.equal(order!.items.length, 1);
  assert.equal(order!.items[0].inferredCategory, 'Transport');
  assert.equal(order!.trip?.distance, 12.3);
  assert.equal(order!.trip?.distanceUnit, 'km');
  assert.equal(order!.trip?.durationMinutes, 27);
  assert.equal(order!.trip?.pickupAddress, '123 Main St, Toronto');
  assert.equal(order!.trip?.dropoffAddress, '456 King St W, Toronto');
});

test('parseUberRide returns null for a non-ride body', () => {
  assert.equal(parseUberRide('Your Uber Eats order. Total $11.00'), null);
});
