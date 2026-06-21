/**
 * Unit tests for the async FX-normalization helper used by the
 * portfolio routes before invoking the pure ACB engine. Uses an
 * injected fake FX fetcher so no network is hit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeActivitiesToCad } from './normalizeActivitiesCurrency';
import type { AcbActivity } from './acb';

let nextId = 1;
function act(opts: {
  tradeDate: string;
  activityType?: string;
  quantity?: number | null;
  amount?: number | null;
  currency: string;
  fees?: number | null;
}): AcbActivity {
  return {
    id: nextId++,
    tradeDate: opts.tradeDate,
    activityType: opts.activityType ?? 'buy',
    quantity: opts.quantity ?? 1,
    amount: opts.amount ?? null,
    currency: opts.currency,
    fees: opts.fees ?? null,
  };
}

const APPROX = (a: number, b: number, msg?: string, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, msg ?? `${a} ≉ ${b}`);

test('all-same-currency stream is passed through unchanged', async () => {
  const activities = [
    act({ tradeDate: '2024-01-15', amount: 1000, currency: 'CAD' }),
    act({ tradeDate: '2024-02-15', amount: 500, currency: 'CAD' }),
  ];
  const calls: Array<[string, string, string]> = [];
  const fetchRate = async (from: string, to: string, date: string) => {
    calls.push([from, to, date]);
    return { rate: 1.5 };
  };
  const { normalized, warnings } = await normalizeActivitiesToCad(activities, fetchRate);
  assert.equal(calls.length, 0, 'no FX lookups for single-currency stream');
  assert.equal(warnings.length, 0);
  assert.equal(normalized[0].amount, 1000);
  assert.equal(normalized[0].currency, 'CAD');
  assert.equal(normalized[1].amount, 500);
  assert.equal(normalized[1].currency, 'CAD');
});

test('USD activity in a CAD-base stream is converted using the mocked rate', async () => {
  // First activity is CAD → base currency is CAD. USD activity gets
  // amount + fees multiplied by USD->CAD rate, currency rewritten.
  const activities = [
    act({ tradeDate: '2024-01-15', amount: 1000, currency: 'CAD' }),
    act({ tradeDate: '2024-06-15', amount: 200, fees: 5, currency: 'USD' }),
  ];
  const fetchRate = async (from: string, to: string) => {
    if (from === 'USD' && to === 'CAD') return { rate: 1.35 };
    return null;
  };
  const { normalized, warnings } = await normalizeActivitiesToCad(activities, fetchRate);
  assert.equal(warnings.length, 0);
  assert.equal(normalized[0].currency, 'CAD');
  assert.equal(normalized[0].amount, 1000);
  assert.equal(normalized[1].currency, 'CAD');
  APPROX(normalized[1].amount!, 270);
  APPROX(normalized[1].fees!, 6.75);
});

test('FX lookup failure emits a warning and passes the activity through unconverted', async () => {
  const activities = [
    act({ tradeDate: '2024-01-15', amount: 1000, currency: 'CAD' }),
    act({ tradeDate: '2024-06-15', amount: 200, currency: 'USD' }),
  ];
  const fetchRate = async () => null;
  const { normalized, warnings } = await normalizeActivitiesToCad(activities, fetchRate);
  assert.ok(warnings.some((w) => /FX lookup failed/i.test(w)));
  // Pass-through preserves the original USD amount and currency.
  assert.equal(normalized[1].currency, 'USD');
  assert.equal(normalized[1].amount, 200);
});

test('fees are also converted, alongside amount', async () => {
  const activities = [
    act({ tradeDate: '2024-01-15', amount: 1000, currency: 'CAD' }),
    act({ tradeDate: '2024-06-15', amount: 1000, fees: 9.99, currency: 'USD' }),
  ];
  const fetchRate = async () => ({ rate: 1.4 });
  const { normalized } = await normalizeActivitiesToCad(activities, fetchRate);
  APPROX(normalized[1].amount!, 1400);
  APPROX(normalized[1].fees!, 13.986);
  // Currency rewritten to base.
  assert.equal(normalized[1].currency, 'CAD');
});

test('mixed stream with already-CAD activities is not converted alongside USD ones', async () => {
  // base = CAD (from first activity). Subsequent CAD activities pass
  // through; USD activities get converted; the fetchRate spy confirms
  // CAD activities never trigger a lookup.
  const activities = [
    act({ tradeDate: '2024-01-15', amount: 1000, currency: 'CAD' }),
    act({ tradeDate: '2024-03-15', amount: 500, currency: 'CAD' }),
    act({ tradeDate: '2024-05-15', amount: 300, currency: 'USD' }),
    act({ tradeDate: '2024-07-15', amount: 200, currency: 'CAD' }),
  ];
  const callsByPair: string[] = [];
  const fetchRate = async (from: string, to: string) => {
    callsByPair.push(`${from}->${to}`);
    if (from === 'USD' && to === 'CAD') return { rate: 1.3 };
    return null;
  };
  const { normalized, warnings } = await normalizeActivitiesToCad(activities, fetchRate);
  assert.equal(warnings.length, 0);
  // Only the USD activity triggered an FX lookup.
  assert.deepEqual(callsByPair, ['USD->CAD']);
  // CAD rows untouched.
  assert.equal(normalized[0].amount, 1000);
  assert.equal(normalized[0].currency, 'CAD');
  assert.equal(normalized[1].amount, 500);
  assert.equal(normalized[3].amount, 200);
  // USD row converted.
  assert.equal(normalized[2].currency, 'CAD');
  APPROX(normalized[2].amount!, 390);
});

test('default FX path converts at the rate in effect on the trade date, not a newer cached rate', async () => {
  // ensureFxRate's recency window has no upper date bound, so a freshly
  // cached TODAY rate satisfies its lookup for a 2020 trade date. The
  // default fetcher must reject rates published after the activity date
  // and fall back to the nearest historical row.
  const { FxRate, sequelize } = await import('../models');
  await sequelize.sync({ force: true });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('network disabled in normalizeActivitiesCurrency.test.ts');
  }) as unknown as typeof fetch;
  try {
    const today = new Date().toISOString().slice(0, 10);
    await FxRate.create({
      fromCurrency: 'USD', toCurrency: 'CAD', ratedDate: today,
      rate: '1.37', source: 'test', fetchedAt: new Date(),
    });
    await FxRate.create({
      fromCurrency: 'USD', toCurrency: 'CAD', ratedDate: '2020-01-10',
      rate: '1.305', source: 'test', fetchedAt: new Date(),
    });

    const activities = [
      act({ tradeDate: '2020-01-05', amount: 500, currency: 'CAD' }),
      act({ tradeDate: '2020-01-15', amount: 1000, currency: 'USD' }),
    ];
    const { normalized, warnings } = await normalizeActivitiesToCad(activities);
    assert.equal(warnings.length, 0, warnings.join('; '));
    APPROX(
      normalized[1].amount!,
      1305,
      `expected 1000 × 1.305 (2020 rate), got ${normalized[1].amount}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
