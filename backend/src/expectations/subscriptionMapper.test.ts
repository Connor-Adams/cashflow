/**
 * Pure unit tests for the Expectation<->Subscription mapper (Expectation merge,
 * Task 3). No DB: these exercise the status round-trip and DTO serialization in
 * isolation so the Postgres-only integration test (subscriptionsFold) can stay
 * thin. Run under `yarn test` (matches the `test/*.test.ts` glob).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toSubscriptionStatus,
  fromSubscriptionStatus,
  serializeSubscription,
  type SubscriptionStatus,
} from './subscriptionMapper';
import type { PlannedEventStatus } from '../models/PlannedEvent';

// ---- toSubscriptionStatus (read path: Expectation -> legacy) -------------

test('toSubscriptionStatus: planned (not uncertain) -> active', () => {
  assert.equal(toSubscriptionStatus('planned', false), 'active');
});

test('toSubscriptionStatus: cancelled -> cancelled', () => {
  assert.equal(toSubscriptionStatus('cancelled', false), 'cancelled');
});

test('toSubscriptionStatus: ignored -> ignored', () => {
  assert.equal(toSubscriptionStatus('ignored', false), 'ignored');
});

test('toSubscriptionStatus: statusUncertain wins -> unknown', () => {
  // The uncertainty flag takes precedence over any underlying status.
  assert.equal(toSubscriptionStatus('planned', true), 'unknown');
  assert.equal(toSubscriptionStatus('cancelled', true), 'unknown');
  assert.equal(toSubscriptionStatus('ignored', true), 'unknown');
});

test('toSubscriptionStatus: other planned-event statuses fall through to active', () => {
  // posted/skipped are not surfaced by the subscriptions DTO; they collapse to
  // the catch-all "active" so a subscription row never disappears from the UI.
  assert.equal(toSubscriptionStatus('posted', false), 'active');
  assert.equal(toSubscriptionStatus('skipped', false), 'active');
});

// ---- fromSubscriptionStatus (write path: legacy -> Expectation) ----------

test('fromSubscriptionStatus: active -> planned (not uncertain)', () => {
  assert.deepEqual(fromSubscriptionStatus('active'), {
    status: 'planned',
    statusUncertain: false,
  });
});

test('fromSubscriptionStatus: cancelled -> cancelled (not uncertain)', () => {
  assert.deepEqual(fromSubscriptionStatus('cancelled'), {
    status: 'cancelled',
    statusUncertain: false,
  });
});

test('fromSubscriptionStatus: ignored -> ignored (not uncertain)', () => {
  assert.deepEqual(fromSubscriptionStatus('ignored'), {
    status: 'ignored',
    statusUncertain: false,
  });
});

test('fromSubscriptionStatus: unknown -> planned + statusUncertain', () => {
  assert.deepEqual(fromSubscriptionStatus('unknown'), {
    status: 'planned',
    statusUncertain: true,
  });
});

// ---- Round-trip: legacy -> Expectation -> legacy -------------------------

test('round-trip preserves every legacy status', () => {
  const all: SubscriptionStatus[] = ['active', 'cancelled', 'ignored', 'unknown'];
  for (const status of all) {
    const mapped = fromSubscriptionStatus(status);
    const back = toSubscriptionStatus(mapped.status, mapped.statusUncertain);
    assert.equal(back, status, `round-trip should preserve "${status}"`);
  }
});

test('round-trip: active<->planned', () => {
  const m = fromSubscriptionStatus('active');
  assert.equal(m.status, 'planned');
  assert.equal(m.statusUncertain, false);
  assert.equal(toSubscriptionStatus(m.status, m.statusUncertain), 'active');
});

test('round-trip: cancelled<->cancelled', () => {
  const m = fromSubscriptionStatus('cancelled');
  assert.equal(m.status, 'cancelled');
  assert.equal(m.statusUncertain, false);
  assert.equal(toSubscriptionStatus(m.status, m.statusUncertain), 'cancelled');
});

test('round-trip: ignored<->ignored', () => {
  const m = fromSubscriptionStatus('ignored');
  assert.equal(m.status, 'ignored');
  assert.equal(m.statusUncertain, false);
  assert.equal(toSubscriptionStatus(m.status, m.statusUncertain), 'ignored');
});

test('round-trip: unknown<->planned+statusUncertain', () => {
  const m = fromSubscriptionStatus('unknown');
  assert.equal(m.status, 'planned');
  assert.equal(m.statusUncertain, true);
  assert.equal(toSubscriptionStatus(m.status, m.statusUncertain), 'unknown');
});

// ---- serializeSubscription (Expectation row -> legacy DTO) ---------------

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    householdId: 3,
    name: 'Netflix',
    normalizedName: 'netflix',
    amount: '20.0000',
    currency: 'CAD',
    cadence: 'monthly',
    lastChargeDate: '2026-05-15',
    nextExpectedDate: '2026-06-15',
    status: 'planned' as PlannedEventStatus,
    statusUncertain: false,
    category: 'Streaming',
    annualizedCost: '240.0000',
    priceChangeDetected: false,
    cancellationUrl: null,
    notes: null,
    createdAt: new Date('2026-05-15T00:00:00.000Z'),
    updatedAt: new Date('2026-05-20T00:00:00.000Z'),
    ...overrides,
  };
}

test('serializeSubscription maps name->merchantName and copies passthrough fields', () => {
  const dto = serializeSubscription(row());
  assert.equal(dto.id, 7);
  assert.equal(dto.householdId, 3);
  assert.equal(dto.merchantName, 'Netflix'); // name -> merchantName
  assert.equal(dto.normalizedName, 'netflix');
  assert.equal(dto.amount, '20.0000');
  assert.equal(dto.currency, 'CAD');
  assert.equal(dto.cadence, 'monthly');
  assert.equal(dto.lastChargeDate, '2026-05-15');
  assert.equal(dto.nextExpectedDate, '2026-06-15');
  assert.equal(dto.category, 'Streaming');
  assert.equal(dto.annualizedCost, '240.0000');
  assert.equal(dto.priceChangeDetected, false);
  assert.equal(dto.cancellationUrl, null);
  assert.equal(dto.notes, null);
  // No legacy `name`/`statusUncertain`/`kind` keys leak into the DTO.
  assert.equal('name' in dto, false);
  assert.equal('statusUncertain' in dto, false);
  assert.equal('kind' in dto, false);
});

test('serializeSubscription always emits priceChangeDetected:false (signal moved to Insights)', () => {
  // The price-increase signal now lives in an open `subscription_price_increase`
  // Insight, not the planned_events.price_change_detected column. The mapper
  // emits a fixed `false`; the /subscriptions route derives the accurate value
  // from open Insights. So even a row whose (legacy) column is `true` maps to
  // `false` here.
  const dto = serializeSubscription(row({ priceChangeDetected: true }));
  assert.equal(dto.priceChangeDetected, false);
});

test('serializeSubscription derives legacy status from status+statusUncertain', () => {
  assert.equal(serializeSubscription(row({ status: 'planned' })).status, 'active');
  assert.equal(serializeSubscription(row({ status: 'cancelled' })).status, 'cancelled');
  assert.equal(serializeSubscription(row({ status: 'ignored' })).status, 'ignored');
  assert.equal(
    serializeSubscription(row({ status: 'planned', statusUncertain: true })).status,
    'unknown',
  );
});

test('serializeSubscription stringifies decimal amount/annualizedCost', () => {
  // DECIMAL columns may surface as numbers; the DTO contract is string.
  const dto = serializeSubscription(row({ amount: 20, annualizedCost: 240 }));
  assert.equal(dto.amount, '20');
  assert.equal(dto.annualizedCost, '240');
});

test('serializeSubscription passes through a null nextExpectedDate', () => {
  const dto = serializeSubscription(row({ nextExpectedDate: null }));
  assert.equal(dto.nextExpectedDate, null);
});
