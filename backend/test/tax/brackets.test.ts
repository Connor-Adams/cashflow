import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../../src/tax/util/decimal';
import { ratesFor, applyBrackets, supportedYears } from '../../src/tax/engine/brackets';

test('ratesFor returns 2024 table', () => {
  const r = ratesFor(2024);
  assert.equal(r.year, 2024);
  assert.equal(r.federalBrackets[0].rate.toString(), '0.15');
});

test('ratesFor throws RateTableMissingError for unknown year', () => {
  assert.throws(() => ratesFor(2099), /RateTableMissingError/);
});

test('supportedYears returns sorted ascending list including 2024-2026', () => {
  const years = supportedYears();
  assert.deepEqual(years, [...years].sort((a, b) => a - b));
  assert.ok(years.includes(2024));
  assert.ok(years.includes(2025));
  assert.ok(years.includes(2026));
});

test('applyBrackets at $0 = $0 tax', () => {
  const r = ratesFor(2024);
  assert.equal(applyBrackets(D('0'), r.federalBrackets).toFixed(2), '0.00');
});

test('applyBrackets at $1 below first bracket cap = 15%', () => {
  const r = ratesFor(2024);
  // first cap $55,867; test at $55,866
  assert.equal(
    applyBrackets(D('55866'), r.federalBrackets).toFixed(2),
    D('55866').times('0.15').toFixed(2)
  );
});

test('applyBrackets crosses into 20.5% bracket correctly', () => {
  const r = ratesFor(2024);
  // $60,000: $55,867 × 0.15 + ($60,000 - $55,867) × 0.205
  const expected = D('55867').times('0.15').plus(D('4133').times('0.205'));
  assert.equal(applyBrackets(D('60000'), r.federalBrackets).toFixed(2), expected.toFixed(2));
});

test('applyBrackets at $300k hits top bracket', () => {
  const r = ratesFor(2024);
  const tax = applyBrackets(D('300000'), r.federalBrackets);
  assert.ok(tax.greaterThan(D('70000')));
  assert.ok(tax.lessThan(D('85000')));
});

test('Ontario brackets at $200k', () => {
  const r = ratesFor(2024);
  const tax = applyBrackets(D('200000'), r.provincialBrackets);
  assert.ok(tax.greaterThan(D('15000')));
  assert.ok(tax.lessThan(D('22000')));
});
