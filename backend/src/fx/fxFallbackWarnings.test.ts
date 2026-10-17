import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFxFallbackCollector } from './fxFallbackWarnings';

test('an exact, cached, fetched, or CAD rate produces no warning', () => {
  const fx = createFxFallbackCollector();
  fx.record('USD', '2025-03-13', { ratedDate: '2025-03-13', source: 'cached' });
  fx.record('USD', '2025-03-14', { ratedDate: '2025-03-14', source: 'fetched' });
  fx.record('CAD', '2025-03-14', { ratedDate: '2025-03-14', source: 'cad_identity' });
  assert.deepEqual(fx.warnings(), []);
});

test('a nearest-earlier fallback names the currency, transaction date, and rate date', () => {
  const fx = createFxFallbackCollector();
  fx.record('USD', '2025-03-13', { ratedDate: '2024-12-31', source: 'fallback_nearest' });
  const [w, ...rest] = fx.warnings();
  assert.equal(rest.length, 0);
  assert.match(w, /USD→CAD/);
  assert.match(w, /2025-03-13/);
  assert.match(w, /2024-12-31/);
});

test('a later-dated fallback says the rate post-dates the transaction', () => {
  const fx = createFxFallbackCollector();
  fx.record('USD', '2020-06-15', { ratedDate: '2026-01-01', source: 'fallback_any' });
  const [w] = fx.warnings();
  assert.match(w, /USD→CAD/);
  assert.match(w, /2020-06-15/);
  assert.match(w, /2026-01-01/);
  assert.match(w, /AFTER/);
});

test('rows sharing a substituted rate collapse into one warning listing each date once', () => {
  const fx = createFxFallbackCollector();
  fx.record('USD', '2025-03-14', { ratedDate: '2024-12-31', source: 'fallback_nearest' });
  fx.record('USD', '2025-03-13', { ratedDate: '2024-12-31', source: 'fallback_nearest' });
  fx.record('USD', '2025-03-13', { ratedDate: '2024-12-31', source: 'fallback_nearest' });
  fx.record('EUR', '2025-03-13', { ratedDate: '2024-11-30', source: 'fallback_nearest' });
  const ws = fx.warnings();
  assert.equal(ws.length, 2);
  const usd = ws.find((w) => w.includes('USD'));
  assert.ok(usd);
  assert.match(usd, /2025-03-13, 2025-03-14/);
  assert.equal(usd.split('2025-03-13').length - 1, 1, 'each date listed once');
});
