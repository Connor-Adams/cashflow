import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMonthWindow,
  lifestyleInflation,
  type LifestyleInflationTxnRow,
} from '../src/summary/lifestyleInflation';

function row(
  over: Partial<LifestyleInflationTxnRow> = {},
): LifestyleInflationTxnRow {
  return {
    date: '2026-05-15',
    currency: 'CAD',
    amount: -100,
    finalCategory: 'Groceries',
    txnType: null,
    accountType: 'credit',
    ...over,
  };
}

// ---------------- buildMonthWindow ----------------

test('buildMonthWindow returns N ascending months ending at anchor', () => {
  const w = buildMonthWindow('2026-05', 4);
  assert.deepEqual(w, ['2026-02', '2026-03', '2026-04', '2026-05']);
});

test('buildMonthWindow crosses a year boundary', () => {
  const w = buildMonthWindow('2026-01', 3);
  assert.deepEqual(w, ['2025-11', '2025-12', '2026-01']);
});

test('buildMonthWindow clamps months to at least 2', () => {
  // A single month cannot express a trend; the helper floors at 2.
  const w = buildMonthWindow('2026-05', 1);
  assert.equal(w.length, 2);
  assert.deepEqual(w, ['2026-04', '2026-05']);
});

// ---------------- lifestyleInflation: basic series ----------------

test('produces a per-currency monthly series covering the whole window', () => {
  const months = buildMonthWindow('2026-04', 4); // Jan..Apr 2026
  const res = lifestyleInflation({
    months,
    currency: null,
    transactions: [
      row({ date: '2026-01-10', amount: -100, finalCategory: 'Groceries' }),
      row({ date: '2026-01-31', amount: 2000, finalCategory: null }), // income
      row({ date: '2026-04-05', amount: -300, finalCategory: 'Groceries' }),
      row({ date: '2026-04-30', amount: 2200, finalCategory: null }), // income
    ],
  });
  assert.equal(res.windowMonths.length, 4);
  assert.equal(res.byCurrency.length, 1);
  const cad = res.byCurrency[0];
  assert.equal(cad.currency, 'CAD');
  // Series has one entry per window month, in order, including empty months.
  assert.equal(cad.series.length, 4);
  assert.deepEqual(
    cad.series.map((m) => m.month),
    ['2026-01', '2026-02', '2026-03', '2026-04'],
  );
  // Jan: income 2000, spend 100, savings 1900
  assert.equal(cad.series[0].income, 2000);
  assert.equal(cad.series[0].spend, 100);
  assert.equal(cad.series[0].savings, 1900);
  // Empty months are zeroed, not dropped.
  assert.equal(cad.series[1].income, 0);
  assert.equal(cad.series[1].spend, 0);
  // Apr: income 2200, spend 300, savings 1900
  assert.equal(cad.series[3].income, 2200);
  assert.equal(cad.series[3].spend, 300);
});

test('income is positive amounts, spend is abs of negative amounts', () => {
  const months = buildMonthWindow('2026-02', 2);
  const res = lifestyleInflation({
    months,
    currency: 'CAD',
    transactions: [
      row({ date: '2026-02-01', amount: -50, finalCategory: 'Dining' }),
      row({ date: '2026-02-02', amount: -25, finalCategory: 'Dining' }),
      row({ date: '2026-02-03', amount: 500, finalCategory: null }),
    ],
  });
  const feb = res.byCurrency[0].series.find((m) => m.month === '2026-02')!;
  assert.equal(feb.spend, 75);
  assert.equal(feb.income, 500);
});

// ---------------- exclusions ----------------

test('excludes non-categorical txn types (transfer/investment/dividend)', () => {
  const months = buildMonthWindow('2026-02', 2);
  const res = lifestyleInflation({
    months,
    currency: 'CAD',
    transactions: [
      row({ date: '2026-02-01', amount: -1000, txnType: 'transfer' }),
      row({ date: '2026-02-02', amount: -500, txnType: 'investment' }),
      row({ date: '2026-02-03', amount: 300, txnType: 'dividend' }),
      row({ date: '2026-02-04', amount: -40, finalCategory: 'Coffee' }),
    ],
  });
  const feb = res.byCurrency[0].series.find((m) => m.month === '2026-02')!;
  assert.equal(feb.spend, 40, 'only the Coffee row counts as spend');
  assert.equal(feb.income, 0, 'dividend is excluded from income');
});

test('excludes investment-account rows regardless of txnType', () => {
  const months = buildMonthWindow('2026-02', 2);
  const res = lifestyleInflation({
    months,
    currency: 'CAD',
    transactions: [
      row({ date: '2026-02-01', amount: -1000, accountType: 'investment' }),
      row({ date: '2026-02-02', amount: -40, finalCategory: 'Coffee' }),
    ],
  });
  const feb = res.byCurrency[0].series.find((m) => m.month === '2026-02')!;
  assert.equal(feb.spend, 40);
});

// ---------------- growth + outpacing insight ----------------

test('flags spending outpacing income with a warning insight', () => {
  const months = buildMonthWindow('2026-06', 6); // Jan..Jun
  // Income flat at 3000/mo. Spend ramps hard in the second half.
  const txns: LifestyleInflationTxnRow[] = [];
  const spendByMonth: Record<string, number> = {
    '2026-01': 1000,
    '2026-02': 1000,
    '2026-03': 1000,
    '2026-04': 2000,
    '2026-05': 2200,
    '2026-06': 2400,
  };
  for (const m of months) {
    txns.push(row({ date: `${m}-15`, amount: -spendByMonth[m], finalCategory: 'Dining' }));
    txns.push(row({ date: `${m}-28`, amount: 3000, finalCategory: null }));
  }
  const res = lifestyleInflation({ months, currency: 'CAD', transactions: txns });
  const cad = res.byCurrency[0];
  assert.equal(cad.spendGrowth.firstHalfAvg, 1000);
  assert.equal(cad.spendGrowth.secondHalfAvg, 2200); // (2000+2200+2400)/3
  assert.equal(cad.incomeGrowth.firstHalfAvg, 3000);
  assert.equal(cad.incomeGrowth.secondHalfAvg, 3000);
  // Spend grew 120%; income grew 0% — definitely outpacing.
  assert.equal(cad.spendOutpacingIncome, true);
  assert.ok(cad.spendGrowthPct != null && cad.spendGrowthPct > 100);
  assert.equal(cad.incomeGrowthPct, 0);
  // An insight should be emitted at high severity.
  assert.ok(cad.insight, 'expected a warning insight');
  assert.equal(cad.insight?.kind, 'lifestyle_inflation');
  assert.ok(['medium', 'high'].includes(cad.insight!.severity));
  assert.match(cad.insight!.summary, /spending/i);
});

test('no insight when spend growth does not exceed income growth by threshold', () => {
  const months = buildMonthWindow('2026-06', 6);
  const txns: LifestyleInflationTxnRow[] = [];
  for (const m of months) {
    // Spend and income both flat — no inflation.
    txns.push(row({ date: `${m}-15`, amount: -1000, finalCategory: 'Dining' }));
    txns.push(row({ date: `${m}-28`, amount: 3000, finalCategory: null }));
  }
  const res = lifestyleInflation({ months, currency: 'CAD', transactions: txns });
  const cad = res.byCurrency[0];
  assert.equal(cad.spendOutpacingIncome, false);
  assert.equal(cad.insight, null);
});

test('honors a custom outpace threshold', () => {
  const months = buildMonthWindow('2026-06', 6);
  const txns: LifestyleInflationTxnRow[] = [];
  const spend: Record<string, number> = {
    '2026-01': 1000, '2026-02': 1000, '2026-03': 1000,
    '2026-04': 1100, '2026-05': 1100, '2026-06': 1100,
  };
  for (const m of months) {
    txns.push(row({ date: `${m}-15`, amount: -spend[m], finalCategory: 'Dining' }));
    txns.push(row({ date: `${m}-28`, amount: 3000, finalCategory: null }));
  }
  // Spend grew 10%, income flat. Default threshold 10pp -> not strictly greater,
  // so no insight. A 5pp threshold -> insight.
  const lenient = lifestyleInflation({ months, currency: 'CAD', transactions: txns });
  assert.equal(lenient.byCurrency[0].spendOutpacingIncome, false);
  const strict = lifestyleInflation({
    months,
    currency: 'CAD',
    transactions: txns,
    outpaceThresholdPct: 5,
  });
  assert.equal(strict.byCurrency[0].spendOutpacingIncome, true);
});

// ---------------- category drivers ----------------

test('identifies categories driving spend growth', () => {
  const months = buildMonthWindow('2026-04', 4); // Jan..Apr
  const txns: LifestyleInflationTxnRow[] = [
    // Dining ramps up; Groceries flat; Travel new in second half.
    row({ date: '2026-01-10', amount: -100, finalCategory: 'Dining' }),
    row({ date: '2026-02-10', amount: -100, finalCategory: 'Dining' }),
    row({ date: '2026-03-10', amount: -400, finalCategory: 'Dining' }),
    row({ date: '2026-04-10', amount: -500, finalCategory: 'Dining' }),
    row({ date: '2026-01-11', amount: -200, finalCategory: 'Groceries' }),
    row({ date: '2026-02-11', amount: -200, finalCategory: 'Groceries' }),
    row({ date: '2026-03-11', amount: -200, finalCategory: 'Groceries' }),
    row({ date: '2026-04-11', amount: -200, finalCategory: 'Groceries' }),
    row({ date: '2026-04-12', amount: -300, finalCategory: 'Travel' }),
  ];
  const res = lifestyleInflation({ months, currency: 'CAD', transactions: txns });
  const cad = res.byCurrency[0];
  const drivers = cad.categoryDrivers;
  assert.ok(drivers.length >= 1);
  // Dining had the biggest absolute jump (first half avg 100 -> second half 450).
  assert.equal(drivers[0].category, 'Dining');
  assert.ok(drivers[0].delta > 0);
  // Groceries (flat) should not be the top driver and ideally excluded (delta 0).
  const groceries = drivers.find((d) => d.category === 'Groceries');
  if (groceries) assert.equal(groceries.delta, 0);
});

// ---------------- currency handling ----------------

test('splits results per currency and respects the currency filter', () => {
  const months = buildMonthWindow('2026-02', 2);
  const txns: LifestyleInflationTxnRow[] = [
    row({ date: '2026-02-01', amount: -100, currency: 'CAD' }),
    row({ date: '2026-02-02', amount: -50, currency: 'USD' }),
  ];
  const all = lifestyleInflation({ months, currency: null, transactions: txns });
  assert.deepEqual(
    all.byCurrency.map((c) => c.currency).sort(),
    ['CAD', 'USD'],
  );
  const cadOnly = lifestyleInflation({ months, currency: 'CAD', transactions: txns });
  assert.equal(cadOnly.byCurrency.length, 1);
  assert.equal(cadOnly.byCurrency[0].currency, 'CAD');
});

// ---------------- missing income data ----------------

test('handles months with zero income gracefully (no divide-by-zero)', () => {
  const months = buildMonthWindow('2026-04', 4);
  // No income rows at all — only spend. incomeGrowthPct should be null, not NaN.
  const txns: LifestyleInflationTxnRow[] = [
    row({ date: '2026-01-10', amount: -100, finalCategory: 'Dining' }),
    row({ date: '2026-04-10', amount: -300, finalCategory: 'Dining' }),
  ];
  const res = lifestyleInflation({ months, currency: 'CAD', transactions: txns });
  const cad = res.byCurrency[0];
  assert.equal(cad.incomeGrowth.firstHalfAvg, 0);
  assert.equal(cad.incomeGrowth.secondHalfAvg, 0);
  // Income went from 0 to 0 -> pct change undefined (null), never NaN.
  assert.equal(cad.incomeGrowthPct, null);
  assert.ok(Number.isFinite(cad.spendGrowth.secondHalfAvg));
  // With zero income the savings line is just negative spend; still finite.
  for (const m of cad.series) {
    assert.ok(Number.isFinite(m.savings));
  }
});

test('returns empty byCurrency when there are no transactions', () => {
  const months = buildMonthWindow('2026-04', 4);
  const res = lifestyleInflation({ months, currency: null, transactions: [] });
  assert.deepEqual(res.byCurrency, []);
  assert.equal(res.windowMonths.length, 4);
});
