/**
 * Unit tests for the pure compute helpers in metrics.ts.
 * Loader is exercised end-to-end via the route integration tests
 * (Task 2 / Task 3); this file only covers the pure math.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRowMetrics,
  computeWeightPct,
  computeTotalReturnPct,
  computeUnifiedTodayDelta,
  type MetricsContext,
} from '../../src/portfolio/metrics';

function emptyContext(): MetricsContext {
  return {
    latestDaily: new Map(),
    prevDaily: new Map(),
    daily30dAgo: new Map(),
    latestQuotes: new Map(),
    divPerUnit30d: new Map(),
    divPerUnit365d: new Map(),
    fxRates: new Map(),
    realizedBySec: new Map(),
    dividendsBySec: new Map(),
    interestBySec: new Map(),
  };
}

test('computeRowMetrics returns all-null when context is empty', () => {
  const m = computeRowMetrics({ ctx: emptyContext(), securityId: 1, qty: 10, costBasis: 100 });
  assert.equal(m.todayChangePct, null);
  assert.equal(m.thirtyDayReturnPct, null);
  assert.equal(m.yieldOnCostPct, null);
});

test('computeRowMetrics computes todayChangePct from latestQuote + prevDaily', () => {
  const ctx = emptyContext();
  ctx.latestQuotes.set(1, { price: 110, currency: 'USD' });
  ctx.prevDaily.set(1, { close: 100, adjClose: 100, date: '2026-05-23' });
  const m = computeRowMetrics({ ctx, securityId: 1, qty: 10, costBasis: 800 });
  assert.equal(m.todayChangePct, 10);
});

test('computeRowMetrics todayChangePct null when no latestQuote', () => {
  const ctx = emptyContext();
  ctx.prevDaily.set(1, { close: 100, adjClose: 100, date: '2026-05-23' });
  const m = computeRowMetrics({ ctx, securityId: 1, qty: 10, costBasis: 800 });
  assert.equal(m.todayChangePct, null);
});

test('computeRowMetrics thirtyDayReturnPct adds dividends to numerator', () => {
  const ctx = emptyContext();
  ctx.latestQuotes.set(1, { price: 110, currency: 'USD' });
  ctx.daily30dAgo.set(1, { adjClose: 100 });
  ctx.divPerUnit30d.set(1, 2);
  const m = computeRowMetrics({ ctx, securityId: 1, qty: 10, costBasis: 800 });
  // ((110 + 2) - 100) / 100 = 12 %
  assert.equal(m.thirtyDayReturnPct, 12);
});

test('computeRowMetrics thirtyDayReturnPct falls back to latestDaily when no quote', () => {
  const ctx = emptyContext();
  ctx.latestDaily.set(1, { close: 110, adjClose: 110, date: '2026-05-24' });
  ctx.daily30dAgo.set(1, { adjClose: 100 });
  const m = computeRowMetrics({ ctx, securityId: 1, qty: 10, costBasis: 800 });
  assert.equal(m.thirtyDayReturnPct, 10);
});

test('computeRowMetrics yieldOnCostPct uses div_per_unit_365d * qty / costBasis', () => {
  const ctx = emptyContext();
  ctx.divPerUnit365d.set(1, 2.5);
  const m = computeRowMetrics({ ctx, securityId: 1, qty: 10, costBasis: 500 });
  // (2.5 * 10 / 500) * 100 = 5
  assert.equal(m.yieldOnCostPct, 5);
});

test('computeRowMetrics yieldOnCostPct null when costBasis is null', () => {
  const ctx = emptyContext();
  ctx.divPerUnit365d.set(1, 2.5);
  const m = computeRowMetrics({ ctx, securityId: 1, qty: 10, costBasis: null });
  assert.equal(m.yieldOnCostPct, null);
});

test('computeRowMetrics yieldOnCostPct null when costBasis is zero', () => {
  const ctx = emptyContext();
  ctx.divPerUnit365d.set(1, 2.5);
  const m = computeRowMetrics({ ctx, securityId: 1, qty: 10, costBasis: 0 });
  assert.equal(m.yieldOnCostPct, null);
});

test('computeWeightPct correct when unifiedTotal > 0', () => {
  assert.equal(computeWeightPct({ ctx: emptyContext(), cadMarketValue: 250, unifiedTotalCad: 1000 }), 25);
});

test('computeWeightPct null when unifiedTotal is null', () => {
  assert.equal(computeWeightPct({ ctx: emptyContext(), cadMarketValue: 250, unifiedTotalCad: null }), null);
});

test('computeWeightPct null when unifiedTotal is zero', () => {
  assert.equal(computeWeightPct({ ctx: emptyContext(), cadMarketValue: 250, unifiedTotalCad: 0 }), null);
});

test('computeTotalReturnPct includes realized + dividends + interest', () => {
  const ctx = emptyContext();
  ctx.realizedBySec.set(1, 50);
  ctx.dividendsBySec.set(1, 30);
  ctx.interestBySec.set(1, 5);
  // (currentMV 200 + realized 50 + (30 + 5) - cost 100) / 100 * 100 = 185%
  const v = computeTotalReturnPct({ ctx, securityId: 1, currentMV: 200, costBasis: 100 });
  assert.equal(v, 185);
});

test('computeTotalReturnPct null when costBasis is null', () => {
  const v = computeTotalReturnPct({ ctx: emptyContext(), securityId: 1, currentMV: 200, costBasis: null });
  assert.equal(v, null);
});

test('computeTotalReturnPct null when costBasis is zero', () => {
  const v = computeTotalReturnPct({ ctx: emptyContext(), securityId: 1, currentMV: 200, costBasis: 0 });
  assert.equal(v, null);
});

test('computeUnifiedTodayDelta sums only securities with prev-day prices', () => {
  const ctx = emptyContext();
  // Sec 1: full data
  ctx.latestQuotes.set(1, { price: 110, currency: 'USD' });
  ctx.prevDaily.set(1, { close: 100, adjClose: 100, date: '2026-05-23' });
  ctx.fxRates.set('USD', 1.35);
  // Sec 2: no prev daily → excluded entirely
  ctx.latestQuotes.set(2, { price: 50, currency: 'CAD' });
  // Sec 3: CAD, no FX needed
  ctx.latestQuotes.set(3, { price: 22, currency: 'CAD' });
  ctx.prevDaily.set(3, { close: 20, adjClose: 20, date: '2026-05-23' });

  const out = computeUnifiedTodayDelta({
    ctx,
    holdings: [
      { securityId: 1, quantity: 10, currency: 'USD' },
      { securityId: 2, quantity: 5, currency: 'CAD' },
      { securityId: 3, quantity: 10, currency: 'CAD' },
    ],
  });
  // Sec 1: today 110*10*1.35 = 1485; prev 100*10*1.35 = 1350
  // Sec 3: today 22*10 = 220; prev 20*10 = 200
  // sumToday = 1705; sumPrev = 1550; delta = 155; pct = 155/1550*100 = 10
  assert.equal(out.todayChangeCad, 155);
  assert.equal(out.todayChangePct, 10);
});

test('computeUnifiedTodayDelta null when no securities have prev-day data', () => {
  const ctx = emptyContext();
  ctx.latestQuotes.set(1, { price: 110, currency: 'CAD' });
  const out = computeUnifiedTodayDelta({
    ctx,
    holdings: [{ securityId: 1, quantity: 10, currency: 'CAD' }],
  });
  assert.equal(out.todayChangeCad, null);
  assert.equal(out.todayChangePct, null);
});

test('computeUnifiedTodayDelta null when FX rate missing for a non-CAD currency', () => {
  const ctx = emptyContext();
  ctx.latestQuotes.set(1, { price: 110, currency: 'USD' });
  ctx.prevDaily.set(1, { close: 100, adjClose: 100, date: '2026-05-23' });
  // no fxRates.set('USD', ...)  → security skipped
  const out = computeUnifiedTodayDelta({
    ctx,
    holdings: [{ securityId: 1, quantity: 10, currency: 'USD' }],
  });
  assert.equal(out.todayChangeCad, null);
  assert.equal(out.todayChangePct, null);
});
