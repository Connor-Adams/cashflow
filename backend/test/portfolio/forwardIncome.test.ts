/**
 * Unit tests for inferCadence and projectNextEvents in forwardIncome.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferCadence, projectNextEvents, type PaymentEvent } from '../../src/portfolio/forwardIncome';

const asOf = new Date('2025-01-01T00:00:00.000Z');

function daysAgo(n: number): Date {
  return new Date(asOf.getTime() - n * 24 * 60 * 60 * 1000);
}

function approxEqual(actual: number, expected: number, eps = 1e-4) {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected ~${expected}, got ${actual}`,
  );
}

// Empty events array
test('inferCadence — empty events returns zero/null defaults', () => {
  const r = inferCadence([], asOf);
  assert.equal(r.annualPerShare, 0);
  assert.equal(r.medianSpacingDays, null);
  assert.equal(r.cadenceLabel, 'none');
  assert.equal(r.cvPct, null);
  assert.equal(r.eventCount12mo, 0);
});

// 12 monthly events (~30 days apart, all 0.10)
test('inferCadence — 12 monthly events → monthly, annualPerShare≈1.20, medianSpacing=30, cvPct≈0', () => {
  const events: PaymentEvent[] = Array.from({ length: 12 }, (_, i) => ({
    date: daysAgo(30 * (11 - i)),
    perShareAmount: 0.1,
  }));
  const r = inferCadence(events, asOf);
  assert.equal(r.cadenceLabel, 'monthly');
  approxEqual(r.annualPerShare, 1.2);
  assert.equal(r.medianSpacingDays, 30);
  assert.ok(r.cvPct !== null && r.cvPct < 0.1, `expected cvPct≈0, got ${r.cvPct}`);
  assert.equal(r.eventCount12mo, 12);
});

// 4 quarterly events (~90 days apart, all 0.50)
test('inferCadence — 4 quarterly events → quarterly, annualPerShare≈2.0, medianSpacing=90', () => {
  const events: PaymentEvent[] = Array.from({ length: 4 }, (_, i) => ({
    date: daysAgo(90 * (3 - i)),
    perShareAmount: 0.5,
  }));
  const r = inferCadence(events, asOf);
  assert.equal(r.cadenceLabel, 'quarterly');
  approxEqual(r.annualPerShare, 2.0);
  assert.equal(r.medianSpacingDays, 90);
  assert.equal(r.eventCount12mo, 4);
});

// 2 events (semiannual spacing)
test('inferCadence — 2 events → semiannual', () => {
  const events: PaymentEvent[] = [
    { date: daysAgo(180), perShareAmount: 1.0 },
    { date: daysAgo(0), perShareAmount: 1.0 },
  ];
  const r = inferCadence(events, asOf);
  assert.equal(r.cadenceLabel, 'semiannual');
  assert.equal(r.eventCount12mo, 2);
});

// 1 event
test('inferCadence — 1 event → annual', () => {
  const events: PaymentEvent[] = [
    { date: daysAgo(100), perShareAmount: 2.0 },
  ];
  const r = inferCadence(events, asOf);
  assert.equal(r.cadenceLabel, 'annual');
  assert.equal(r.eventCount12mo, 1);
});

// 7 events (50 days apart) → irregular
test('inferCadence — 7 events (50 days apart) → irregular', () => {
  const events: PaymentEvent[] = Array.from({ length: 7 }, (_, i) => ({
    date: daysAgo(50 * (6 - i)),
    perShareAmount: 0.3,
  }));
  const r = inferCadence(events, asOf);
  assert.equal(r.cadenceLabel, 'irregular');
  assert.equal(r.eventCount12mo, 7);
});

// 3 events → cvPct is null (need 4)
test('inferCadence — 3 events → cvPct is null', () => {
  const events: PaymentEvent[] = Array.from({ length: 3 }, (_, i) => ({
    date: daysAgo(90 * (2 - i)),
    perShareAmount: 0.5,
  }));
  const r = inferCadence(events, asOf);
  assert.equal(r.cvPct, null);
});

// 4 events with varying values → cvPct > 25
test('inferCadence — 4 events with values [0.1,0.2,0.3,0.4] → cvPct > 25', () => {
  const amounts = [0.1, 0.2, 0.3, 0.4];
  const events: PaymentEvent[] = amounts.map((perShareAmount, i) => ({
    date: daysAgo(90 * (3 - i)),
    perShareAmount,
  }));
  const r = inferCadence(events, asOf);
  assert.ok(r.cvPct !== null && r.cvPct > 25, `expected cvPct > 25, got ${r.cvPct}`);
});

// Event outside 365-day window is excluded
test('inferCadence — event outside 365-day window is excluded from annualPerShare and eventCount12mo', () => {
  const events: PaymentEvent[] = [
    { date: daysAgo(366), perShareAmount: 5.0 }, // outside window
    { date: daysAgo(30), perShareAmount: 0.5 },  // inside window
  ];
  const r = inferCadence(events, asOf);
  assert.equal(r.eventCount12mo, 1);
  approxEqual(r.annualPerShare, 0.5);
});

// ── projectNextEvents ──────────────────────────────────────────────────────────

const asOf2 = new Date('2026-05-25T00:00:00.000Z');

// medianSpacingDays > horizon → empty array
test('projectNextEvents — medianSpacingDays > horizon returns empty array', () => {
  const result = projectNextEvents({
    lastEventDate: new Date('2026-05-01T00:00:00.000Z'),
    medianSpacingDays: 180,
    lastPerShareAmount: 0.5,
    horizonDays: 90,
    asOf: asOf2,
  });
  assert.deepEqual(result, []);
});

// Monthly cadence, horizon=90 → 2-3 entries, all have correct estimatedPerShare
test('projectNextEvents — monthly cadence (spacing=30), horizon=90, returns 2-3 entries with correct estimatedPerShare', () => {
  const result = projectNextEvents({
    lastEventDate: new Date('2026-05-01T00:00:00.000Z'),
    medianSpacingDays: 30,
    lastPerShareAmount: 0.25,
    horizonDays: 90,
    asOf: asOf2,
  });
  assert.equal(result.length, 3);
  for (const entry of result) {
    assert.equal(entry.estimatedPerShare, 0.25);
  }
});

// Quarterly cadence → single entry with date 2026-07-14
test('projectNextEvents — quarterly cadence (spacing=90), horizon=90, lastEventDate=2026-04-15, returns 1 entry with date 2026-07-14', () => {
  const result = projectNextEvents({
    lastEventDate: new Date('2026-04-15T00:00:00.000Z'),
    medianSpacingDays: 90,
    lastPerShareAmount: 1.0,
    horizonDays: 90,
    asOf: asOf2,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].date.toISOString().slice(0, 10), '2026-07-14');
});

// lastEventDate well in the past → all returned dates are after asOf
test('projectNextEvents — lastEventDate well in the past with monthly cadence → all returned dates are after asOf', () => {
  const result = projectNextEvents({
    lastEventDate: new Date('2026-03-01T00:00:00.000Z'),
    medianSpacingDays: 30,
    lastPerShareAmount: 0.1,
    horizonDays: 90,
    asOf: asOf2,
  });
  assert.ok(result.length > 0, 'expected at least one result');
  for (const entry of result) {
    assert.ok(entry.date > asOf2, `expected date after asOf, got ${entry.date.toISOString()}`);
  }
});
