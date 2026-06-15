/**
 * Unit tests for the pure holding-valuation helper.
 *
 * Covers the quote-vs-broker per-unit sanity guard added for issue #549:
 * a live quote that diverges implausibly from the broker-imported per-unit
 * price (a symbol→ticker collision, e.g. "GOLD" resolving to GoldMining Inc
 * GOLD.TO) must NOT override the correct broker-imported market value.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHoldingMarketValue, QUOTE_DIVERGENCE_RATIO } from './valuation';

test('resolveHoldingMarketValue — quote used when no broker value to compare', () => {
  const r = resolveHoldingMarketValue({
    quantity: 10,
    importedValue: null,
    importedPrice: null,
    quotePrice: 5,
  });
  assert.equal(r.marketValue, 50);
  assert.equal(r.usedQuote, true);
});

test('resolveHoldingMarketValue — falls back to imported value when no quote', () => {
  const r = resolveHoldingMarketValue({
    quantity: 10,
    importedValue: 123.45,
    importedPrice: 12.345,
    quotePrice: null,
  });
  assert.equal(r.marketValue, 123.45);
  assert.equal(r.usedQuote, false);
});

test('resolveHoldingMarketValue — zero when neither quote nor imported value', () => {
  const r = resolveHoldingMarketValue({
    quantity: 10,
    importedValue: null,
    importedPrice: null,
    quotePrice: null,
  });
  assert.equal(r.marketValue, 0);
  assert.equal(r.usedQuote, false);
});

test('resolveHoldingMarketValue — quote used when within tolerance of broker per-unit', () => {
  // Broker per-unit 100; quote 120 (1.2x) — a plausible market move, accept.
  const r = resolveHoldingMarketValue({
    quantity: 4,
    importedValue: 400,
    importedPrice: 100,
    quotePrice: 120,
  });
  assert.equal(r.marketValue, 480);
  assert.equal(r.usedQuote, true);
});

test('resolveHoldingMarketValue — GOLD collision: penny-stock quote rejected, broker value kept', () => {
  // Real prod case (#549): broker "Physically backed gold" ~$6233/oz CAD,
  // qty ~0.5054, imported MV $3150.53. Yahoo resolves bare "GOLD" to GOLD.TO
  // (GoldMining Inc) ~$1.56 → would compute $0.79. Guard must reject the quote.
  const r = resolveHoldingMarketValue({
    quantity: 0.5054,
    importedValue: 3150.53,
    importedPrice: 6233.0,
    quotePrice: 1.56,
  });
  assert.equal(r.marketValue, 3150.53);
  assert.equal(r.usedQuote, false);
});

test('resolveHoldingMarketValue — quote far above broker per-unit also rejected', () => {
  // Inverse collision: quote 100x the broker per-unit price → reject.
  const r = resolveHoldingMarketValue({
    quantity: 2,
    importedValue: 20,
    importedPrice: 10,
    quotePrice: 1000,
  });
  assert.equal(r.marketValue, 20);
  assert.equal(r.usedQuote, false);
});

test('resolveHoldingMarketValue — derives broker per-unit from MV/qty when price missing', () => {
  // No importedPrice, but importedValue/qty = 10 per unit; quote 4000 → reject.
  const r = resolveHoldingMarketValue({
    quantity: 5,
    importedValue: 50,
    importedPrice: null,
    quotePrice: 4000,
  });
  assert.equal(r.marketValue, 50);
  assert.equal(r.usedQuote, false);
});

test('resolveHoldingMarketValue — guard inactive when broker per-unit unknown', () => {
  // importedValue present but qty is 0 and no importedPrice → cannot derive a
  // per-unit reference, so the guard cannot fire; quote is used.
  const r = resolveHoldingMarketValue({
    quantity: 0,
    importedValue: 50,
    importedPrice: null,
    quotePrice: 4000,
  });
  assert.equal(r.marketValue, 0); // qty 0 → 0 * quote
  assert.equal(r.usedQuote, true);
});

test('QUOTE_DIVERGENCE_RATIO is a sane order-of-magnitude band', () => {
  assert.ok(QUOTE_DIVERGENCE_RATIO >= 2 && QUOTE_DIVERGENCE_RATIO <= 10);
});
