import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { FxRate } from '../models';
import { D } from '../tax/util/decimal';
import { toCad } from './toCad';

// Stub fetch to simulate no network — keeps tests deterministic regardless of
// whether the runner has real BoC API access. Tests that need network can
// override globalThis.fetch in their own try/finally.
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  await sequelize.sync({ force: true });
  globalThis.fetch = (async () => {
    throw new Error('network disabled in toCad.test.ts');
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('CAD short-circuits without DB or HTTP', async () => {
  const result = await toCad(D('100'), 'CAD', '2025-06-15');
  assert.equal(result.cad.toFixed(2), '100.00');
  assert.equal(result.source, 'cad_identity');
  assert.equal(result.rate, 1);
});

test('uses cached recent FxRate when available', async () => {
  await FxRate.create({
    fromCurrency: 'USD',
    toCurrency: 'CAD',
    ratedDate: '2025-06-14',
    rate: '1.36',
    source: 'bank_of_canada',
    fetchedAt: new Date(),
  });
  const result = await toCad(D('100'), 'USD', '2025-06-15');
  assert.equal(result.cad.toFixed(2), '136.00');
  assert.equal(result.rate, 1.36);
  // Network is stubbed to throw, so ensureFxRate must hit the cached row
  // (a fetch would fail). Lock down the cache-hit path specifically.
  assert.equal(result.source, 'cached');
});

test('falls back to nearest historical row when ensureFxRate cannot find one', async () => {
  // Old rate from 2020, well outside ensureFxRate's 7-day cache window.
  await FxRate.create({
    fromCurrency: 'USD',
    toCurrency: 'CAD',
    ratedDate: '2020-03-15',
    rate: '1.40',
    source: 'manual_seed',
    fetchedAt: new Date(),
  });
  // Asking for a rate in 2025: ensureFxRate's 7-day window won't match the 2020 row.
  // ensureFxRate will also attempt to fetch from BoC; in this test we don't have
  // network. The fallback path should still find the 2020 row and use it.
  const result = await toCad(D('100'), 'USD', '2025-06-15');
  assert.equal(result.cad.toFixed(2), '140.00');
  assert.equal(result.source, 'fallback_nearest');
  assert.equal(result.ratedDate, '2020-03-15');
});

test('falls back to any rate for the pair when no on-or-before row exists', async () => {
  // Only future-dated row exists. Real-world: a freshly-seeded test DB with one
  // present-day BoC row, asked for an early historical date.
  await FxRate.create({
    fromCurrency: 'USD',
    toCurrency: 'CAD',
    ratedDate: '2026-01-01',
    rate: '1.38',
    source: 'manual_seed',
    fetchedAt: new Date(),
  });
  const result = await toCad(D('100'), 'USD', '2020-06-15');
  assert.equal(result.cad.toFixed(2), '138.00');
  assert.equal(result.source, 'fallback_any');
});

test('throws only when zero rows exist for the currency pair', async () => {
  await assert.rejects(
    () => toCad(D('100'), 'XYZ', '2025-06-15'),
    /FX rate missing/,
  );
});
