/**
 * Unit tests for currencyExposure aggregator.
 *
 * Pure function over an array of transactions + an FX lookup. The FX
 * lookup is dependency-injected so this file doesn't touch the DB.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCurrencyExposure,
  type ExposureTxnRow,
} from './currencyExposure';
import type { FxLookup } from '../networth/unifyToCad';

const stubFx: FxLookup = async (from, to, asOf) => {
  if (from === to) return { rate: 1, ratedDate: asOf };
  if (from === 'USD' && to === 'CAD') return { rate: 1.35, ratedDate: asOf };
  if (from === 'EUR' && to === 'CAD') return { rate: 1.45, ratedDate: asOf };
  return null;
};

function txn(currency: string, amount: number, date = '2026-01-15'): ExposureTxnRow {
  return { currency, amount: String(amount), date };
}

test('empty input returns empty result', async () => {
  const result = await computeCurrencyExposure([], '2026-05-01', 'CAD', stubFx);
  assert.equal(result.totalCadEquivalent, 0);
  assert.deepEqual(result.byCurrency, []);
  assert.deepEqual(result.gaps, []);
});

test('single-currency CAD aggregation', async () => {
  const txns = [
    txn('CAD', 100),
    txn('CAD', -50),
    txn('CAD', 25),
  ];
  const result = await computeCurrencyExposure(txns, '2026-05-01', 'CAD', stubFx);
  assert.equal(result.byCurrency.length, 1);
  const cad = result.byCurrency[0];
  assert.equal(cad.currency, 'CAD');
  assert.equal(cad.transactionCount, 3);
  assert.equal(cad.sumNative, 75);
  assert.equal(cad.absSumNative, 175);
  assert.equal(cad.cadEquivalent, 75);
});

test('multi-currency mixes summed via FX', async () => {
  const txns = [
    txn('CAD', 100),
    txn('USD', 200), // 270 CAD
    txn('EUR', 50), // 72.5 CAD
  ];
  const result = await computeCurrencyExposure(txns, '2026-05-01', 'CAD', stubFx);
  assert.equal(result.byCurrency.length, 3);
  // total CAD = 100 + 270 + 72.5 = 442.5
  assert.ok(Math.abs(result.totalCadEquivalent - 442.5) < 0.01);
  // CAD entry
  const cad = result.byCurrency.find((r) => r.currency === 'CAD');
  assert.ok(cad);
  assert.equal(cad.cadEquivalent, 100);
  // USD entry
  const usd = result.byCurrency.find((r) => r.currency === 'USD');
  assert.ok(usd);
  assert.ok(Math.abs(usd.cadEquivalent - 270) < 0.01);
  assert.equal(usd.fxRate, 1.35);
  // EUR entry
  const eur = result.byCurrency.find((r) => r.currency === 'EUR');
  assert.ok(eur);
  assert.ok(Math.abs(eur.cadEquivalent - 72.5) < 0.01);
  assert.equal(eur.fxRate, 1.45);
});

test('shareOfTotal sums to ~1 across non-zero currencies', async () => {
  const txns = [txn('USD', 100), txn('EUR', 100)];
  const result = await computeCurrencyExposure(txns, '2026-05-01', 'CAD', stubFx);
  const total = result.byCurrency.reduce((acc, row) => acc + row.shareOfTotal, 0);
  assert.ok(Math.abs(total - 1) < 0.0001);
});

test('emits gap when FX rate missing', async () => {
  const txns = [txn('XYZ', 100), txn('CAD', 50)];
  const result = await computeCurrencyExposure(txns, '2026-05-01', 'CAD', stubFx);
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].currency, 'XYZ');
  // Missing FX → currency still appears in byCurrency with cadEquivalent=null
  const xyz = result.byCurrency.find((r) => r.currency === 'XYZ');
  assert.ok(xyz);
  assert.equal(xyz.cadEquivalent, null);
  // Total only includes the currencies with rates.
  assert.equal(result.totalCadEquivalent, 50);
});

test('reporting currency other than CAD also works', async () => {
  // Going CAD→USD with rate 1/1.35; we use the inverse path through fxLookup.
  // The stub here doesn't define USD→CAD reverse, but we set the reporting
  // currency to CAD elsewhere. This test ensures the function passes the
  // reporting currency through correctly.
  const stubFxBothWays: FxLookup = async (from, to, asOf) => {
    if (from === to) return { rate: 1, ratedDate: asOf };
    if (from === 'CAD' && to === 'USD') return { rate: 0.74, ratedDate: asOf };
    return null;
  };
  const txns = [txn('CAD', 100)];
  const result = await computeCurrencyExposure(txns, '2026-05-01', 'USD', stubFxBothWays);
  assert.equal(result.reportingCurrency, 'USD');
  const cad = result.byCurrency.find((r) => r.currency === 'CAD');
  assert.ok(cad);
  assert.ok(Math.abs((cad.cadEquivalent ?? 0) - 74) < 0.01);
});

test('aggregates by currency case-insensitively but emits uppercase', async () => {
  const txns: ExposureTxnRow[] = [
    { currency: 'usd', amount: '50', date: '2026-01-15' },
    { currency: 'USD', amount: '50', date: '2026-01-15' },
  ];
  const result = await computeCurrencyExposure(txns, '2026-05-01', 'CAD', stubFx);
  const usd = result.byCurrency.find((r) => r.currency === 'USD');
  assert.ok(usd);
  assert.equal(usd.transactionCount, 2);
  assert.equal(usd.sumNative, 100);
});

test('shareOfTotal is volume-based: offsetting flows do not cancel to 0%', async () => {
  // USD has 4x the CAD volume but nets to zero. Exposure share must reflect
  // volume (abs amounts), not the net — otherwise heavy two-way activity
  // reports ~0% exposure.
  const txns = [txn('USD', 100), txn('USD', -100), txn('CAD', 50)];
  const result = await computeCurrencyExposure(txns, '2026-05-01', 'CAD', stubFx);
  const usd = result.byCurrency.find((r) => r.currency === 'USD');
  const cad = result.byCurrency.find((r) => r.currency === 'CAD');
  assert.ok(usd);
  assert.ok(cad);
  // Net conversion is unchanged: USD nets to 0.
  assert.equal(usd.cadEquivalent, 0);
  // Volume: USD 200 native → 270 CAD; CAD 50. Total volume 320.
  assert.ok(Math.abs(usd.shareOfTotal - 270 / 320) < 0.0001);
  assert.ok(Math.abs(cad.shareOfTotal - 50 / 320) < 0.0001);
});

test('shareOfTotal handles zero-total edge', async () => {
  // Two transactions that net to zero CAD-equivalent.
  const txns = [txn('CAD', 100), txn('CAD', -100)];
  const result = await computeCurrencyExposure(txns, '2026-05-01', 'CAD', stubFx);
  assert.equal(result.totalCadEquivalent, 0);
  // shareOfTotal cannot be NaN — must be defined.
  for (const row of result.byCurrency) {
    assert.ok(Number.isFinite(row.shareOfTotal));
  }
});
