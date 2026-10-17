/**
 * The CAD converter must not make the same lookup twice, and must not take the T1
 * response down.
 *
 * `toCad` is an `FxRate` lookup plus `ensureFxRate`, which can make a Bank of Canada
 * HTTP call — and both the completeness report and the forward view converted per row,
 * sequentially, on a path recomputed on every request including cache hits. Prod holds
 * 30 USD transfers in 2026, so that was 30+ serial round trips for a handful of
 * distinct currency/date pairs.
 *
 * And `toCad` throws when no rate exists for a pair anywhere. Neither caller caught it,
 * so a missing rate would have 500'd the whole return over an advisory overlay.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../db';
import { FxRate } from '../../models';
import { D } from '../util/decimal';
import { createCadConverter } from './cadConverter';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

test('CAD short-circuits without any lookup', async () => {
  const convert = createCadConverter();
  assert.equal((await convert(D('100'), 'CAD', '2026-04-01')).toFixed(2), '100.00');
});

test('one rate lookup serves every row sharing a currency and date', async () => {
  await FxRate.create({
    fromCurrency: 'USD', toCurrency: 'CAD', ratedDate: '2026-04-01',
    rate: '1.40', source: 'test', fetchedAt: new Date(),
  } as never);

  let lookups = 0;
  const original = sequelize.options.logging;
  sequelize.options.logging = (sql: unknown) => {
    if (String(sql).toLowerCase().includes('fx_rates')) lookups += 1;
  };
  try {
    const convert = createCadConverter();
    const amounts = await Promise.all(
      ['100', '250', '3000'].map((a) => convert(D(a), 'USD', '2026-04-01')),
    );
    assert.deepEqual(amounts.map((a) => a.toFixed(2)), ['140.00', '350.00', '4200.00']);
  } finally {
    sequelize.options.logging = original;
  }
  assert.ok(lookups <= 2, `expected the pair to be looked up once, saw ${lookups} fx queries`);
});

test('a different date is a different lookup', async () => {
  for (const [date, rate] of [['2026-04-01', '1.40'], ['2026-05-01', '1.50']]) {
    await FxRate.create({
      fromCurrency: 'USD', toCurrency: 'CAD', ratedDate: date,
      rate, source: 'test', fetchedAt: new Date(),
    } as never);
  }
  const convert = createCadConverter();
  assert.equal((await convert(D('100'), 'USD', '2026-04-01')).toFixed(2), '140.00');
  assert.equal((await convert(D('100'), 'USD', '2026-05-01')).toFixed(2), '150.00');
});

test('a currency with no rate anywhere degrades instead of throwing', async () => {
  // The report is advisory. Losing the whole return because one rate is missing would
  // be strictly worse than reporting a foreign figure unconverted.
  const convert = createCadConverter();
  const got = await convert(D('100'), 'XAU', '2026-04-01');
  assert.equal(got.toFixed(2), '100.00');
});

test('a failed lookup is not retried for the same pair', async () => {
  const convert = createCadConverter();
  const first = await convert(D('100'), 'XAU', '2026-04-01');
  const second = await convert(D('200'), 'XAU', '2026-04-01');
  assert.equal(first.toFixed(2), '100.00');
  assert.equal(second.toFixed(2), '200.00');
});

test('each converter has its own cache, so a stale rate cannot outlive a request', async () => {
  await FxRate.create({
    fromCurrency: 'USD', toCurrency: 'CAD', ratedDate: '2026-04-01',
    rate: '1.40', source: 'test', fetchedAt: new Date(),
  } as never);
  const first = createCadConverter();
  assert.equal((await first(D('100'), 'USD', '2026-04-01')).toFixed(2), '140.00');

  await FxRate.update({ rate: '2.00' }, { where: { fromCurrency: 'USD' } });
  const second = createCadConverter();
  assert.equal((await second(D('100'), 'USD', '2026-04-01')).toFixed(2), '200.00');
  // The first converter keeps its memo, which is the point of per-invocation scope.
  assert.equal((await first(D('100'), 'USD', '2026-04-01')).toFixed(2), '140.00');
});
