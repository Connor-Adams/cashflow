import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unifyToCad, type FxLookup } from '../src/networth/unifyToCad';

const stubFx: FxLookup = async (from, to, asOf) => {
  if (from === to) return { rate: 1, ratedDate: asOf };
  if (from === 'USD' && to === 'CAD') return { rate: 1.36, ratedDate: asOf };
  return null;
};

test('unifyToCad: sums per-currency amounts split by kind, includes rates used', async () => {
  const input = {
    CAD: { asset: 1000, liability: -200 },
    USD: { asset: 500, liability: 0 },
  };
  const result = await unifyToCad(input, '2026-05-24', stubFx);
  assert.ok(Math.abs(result.totalAssets - (1000 + 500 * 1.36)) < 0.0001);
  assert.ok(Math.abs(result.totalLiabilities - (-200)) < 0.0001);
  assert.deepEqual(result.gaps, []);
  assert.deepEqual(result.fxRatesUsed, [
    { from: 'USD', to: 'CAD', rate: 1.36, ratedDate: '2026-05-24' },
  ]);
});

test('unifyToCad: excludes a currency that has no FX rate and emits a gap', async () => {
  const input = {
    CAD: { asset: 100, liability: 0 },
    EUR: { asset: 50, liability: 0 },
  };
  const result = await unifyToCad(input, '2026-05-24', stubFx);
  assert.equal(result.totalAssets, 100);
  assert.deepEqual(result.gaps, [
    { date: '2026-05-24', currency: 'EUR', reason: 'fx_rate_unavailable' },
  ]);
});

test('unifyToCad: does not record an FX rate entry for CAD→CAD identity', async () => {
  const input = { CAD: { asset: 100, liability: 0 } };
  const result = await unifyToCad(input, '2026-05-24', stubFx);
  assert.deepEqual(result.fxRatesUsed, []);
});

test('unifyToCad: handles negative liability amounts in non-CAD currency', async () => {
  const input = { USD: { asset: 0, liability: -100 } };
  const result = await unifyToCad(input, '2026-05-24', stubFx);
  assert.ok(Math.abs(result.totalLiabilities - (-100 * 1.36)) < 0.0001);
});
