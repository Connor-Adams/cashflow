/**
 * Unit tests for withCadCrossRates.
 *
 * Pure DI tests — the base lookup is a stub that only knows X→CAD pairs,
 * mirroring what `looseHistoricalFxLookup` can actually resolve in
 * production (the FxRate table only carries X→CAD rows).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withCadCrossRates } from './crossCurrencyFxLookup';
import type { FxLookup } from '../networth/unifyToCad';

/** Base lookup that, like production, ONLY resolves X→CAD. */
const cadOnlyBase: FxLookup = async (from, to) => {
  if (to !== 'CAD') return null;
  if (from === 'USD') return { rate: 1.35, ratedDate: '2026-01-14' };
  if (from === 'EUR') return { rate: 1.45, ratedDate: '2026-01-15' };
  if (from === 'ZRO') return { rate: 0, ratedDate: '2026-01-15' };
  return null;
};

const lookup = withCadCrossRates(cadOnlyBase);

test('identity pair short-circuits without hitting the base lookup', async () => {
  let baseCalled = false;
  const spy = withCadCrossRates(async (...args) => {
    baseCalled = true;
    return cadOnlyBase(...args);
  });
  const result = await spy('USD', 'USD', '2026-01-15');
  assert.deepEqual(result, { rate: 1, ratedDate: '2026-01-15' });
  assert.equal(baseCalled, false);
});

test('X→CAD delegates to the base lookup', async () => {
  const result = await lookup('USD', 'CAD', '2026-01-15');
  assert.deepEqual(result, { rate: 1.35, ratedDate: '2026-01-14' });
});

test('CAD→X inverts the X→CAD rate', async () => {
  const result = await lookup('CAD', 'USD', '2026-01-15');
  assert.ok(result);
  assert.ok(Math.abs(result.rate - 1 / 1.35) < 1e-12);
  assert.equal(result.ratedDate, '2026-01-14');
});

test('X→Y chains via CAD and uses the stalest leg ratedDate', async () => {
  const result = await lookup('EUR', 'USD', '2026-01-15');
  assert.ok(result);
  // EUR→USD = (EUR→CAD) / (USD→CAD) = 1.45 / 1.35
  assert.ok(Math.abs(result.rate - 1.45 / 1.35) < 1e-12);
  assert.equal(result.ratedDate, '2026-01-14');
});

test('returns null when a leg is missing', async () => {
  assert.equal(await lookup('XYZ', 'CAD', '2026-01-15'), null);
  assert.equal(await lookup('CAD', 'XYZ', '2026-01-15'), null);
  assert.equal(await lookup('XYZ', 'USD', '2026-01-15'), null);
  assert.equal(await lookup('USD', 'XYZ', '2026-01-15'), null);
});

test('returns null instead of dividing by a zero rate', async () => {
  assert.equal(await lookup('CAD', 'ZRO', '2026-01-15'), null);
  assert.equal(await lookup('USD', 'ZRO', '2026-01-15'), null);
});
