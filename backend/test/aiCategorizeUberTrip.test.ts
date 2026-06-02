import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorizeUberTrip } from '../src/ai/aiCategorizeUberTrip';
import type { TripDetail } from '../src/ai/extractReceiptItems';

const TRIP: TripDetail = {
  pickupAddress: 'Home',
  dropoffAddress: '200 Bay St (office)',
  distance: 8,
  distanceUnit: 'km',
  durationMinutes: 20,
  requestedAt: '2026-03-03T08:30:00Z',
  driver: null,
  surgeMultiplier: null,
};

test('categorizeUberTrip returns category + businessUsePercent from the model', async () => {
  const fakeCaller = async () => ({
    json: { category: 'Transport', businessUsePercent: 100, confidence: 80, rationale: 'weekday commute to office' },
    raw: '',
    model: 'test',
    promptTokens: 0,
    completionTokens: 0,
  });
  const result = await categorizeUberTrip(TRIP, { caller: fakeCaller as never });
  assert.equal(result.category, 'Transport');
  assert.equal(result.businessUsePercent, 100);
});

test('categorizeUberTrip clamps a missing businessUsePercent to null', async () => {
  const fakeCaller = async () => ({
    json: { category: 'Transport', businessUsePercent: null, confidence: 50, rationale: 'personal' },
    raw: '',
    model: 'test',
    promptTokens: 0,
    completionTokens: 0,
  });
  const result = await categorizeUberTrip(TRIP, { caller: fakeCaller as never });
  assert.equal(result.businessUsePercent, null);
});
