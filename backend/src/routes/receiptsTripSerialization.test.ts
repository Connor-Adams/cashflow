import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderTrip } from './receipts';

test('orderTrip pulls trip out of rawPayload', () => {
  const trip = { pickupAddress: 'A', dropoffAddress: 'B', distance: 5, distanceUnit: 'km',
    durationMinutes: 10, requestedAt: null, driver: null, surgeMultiplier: null };
  assert.deepEqual(orderTrip({ rawPayload: { trip } } as never), trip);
  assert.equal(orderTrip({ rawPayload: null } as never), null);
  assert.equal(orderTrip({ rawPayload: { extracted: {} } } as never), null);
});
