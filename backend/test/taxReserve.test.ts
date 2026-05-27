/**
 * Unit tests for the pure helpers in routes/taxReserve: period bucketing,
 * the single-period composeTaxReserve formula, the multi-period rollup
 * aggregator, and the PUT body validator.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePeriodicity,
  periodKey,
  composeTaxReserve,
  aggregateReserveRollups,
  validateReservePatch,
  type ReserveInputRow,
} from '../src/routes/taxReserve';

// ---- parsePeriodicity ---------------------------------------------------

test('parsePeriodicity: defaults to quarterly when missing', () => {
  assert.equal(parsePeriodicity(undefined), 'quarterly');
});

test('parsePeriodicity: accepts known values (case-insensitive)', () => {
  assert.equal(parsePeriodicity('monthly'), 'monthly');
  assert.equal(parsePeriodicity('QUARTERLY'), 'quarterly');
  assert.equal(parsePeriodicity('Annual'), 'annual');
});

test('parsePeriodicity: falls back on unknown', () => {
  assert.equal(parsePeriodicity('weekly'), 'quarterly');
  assert.equal(parsePeriodicity('weekly', 'monthly'), 'monthly');
});

// ---- periodKey ----------------------------------------------------------

test('periodKey monthly: YYYY-MM-DD becomes YYYY-MM', () => {
  assert.equal(periodKey('2026-03-15', 'monthly'), '2026-03');
  assert.equal(periodKey('2026-01-01', 'monthly'), '2026-01');
  assert.equal(periodKey('2026-12-31', 'monthly'), '2026-12');
});

test('periodKey quarterly: dates collapse to YYYY-Qn', () => {
  assert.equal(periodKey('2026-01-15', 'quarterly'), '2026-Q1');
  assert.equal(periodKey('2026-03-31', 'quarterly'), '2026-Q1');
  assert.equal(periodKey('2026-04-01', 'quarterly'), '2026-Q2');
  assert.equal(periodKey('2026-06-30', 'quarterly'), '2026-Q2');
  assert.equal(periodKey('2026-07-15', 'quarterly'), '2026-Q3');
  assert.equal(periodKey('2026-09-30', 'quarterly'), '2026-Q3');
  assert.equal(periodKey('2026-10-01', 'quarterly'), '2026-Q4');
  assert.equal(periodKey('2026-12-31', 'quarterly'), '2026-Q4');
});

test('periodKey annual: YYYY-MM-DD becomes YYYY', () => {
  assert.equal(periodKey('2026-06-30', 'annual'), '2026');
  assert.equal(periodKey('2025-01-01', 'annual'), '2025');
});

test('periodKey: malformed date falls through unchanged', () => {
  assert.equal(periodKey('not-a-date', 'monthly'), 'not-a-date');
});

// ---- composeTaxReserve --------------------------------------------------

test('composeTaxReserve: net positive income — reserve = net * percent + hst', () => {
  // AC: "Calculate suggested reserve by period". Income > expenses, HST/GST
  // also collected — both flow into the target.
  const r = composeTaxReserve({
    businessIncome: 10000,
    deductibleExpenses: 4000,
    hstGstCollected: 1300,
    hstGstPaid: 200,
    reservePercent: 0.25,
  });
  assert.equal(r.netBusinessIncome, 6000);
  assert.equal(r.netHstGst, 1100);
  // 6000 * 0.25 = 1500 + 1100 = 2600
  assert.equal(r.reserveTarget, 2600);
});

test('composeTaxReserve: net negative income clips to zero before percent', () => {
  // AC: "Calculation is clearly explained in the UI" — a loss period should
  // never suggest a negative reserve. HST/GST owed still flows through.
  const r = composeTaxReserve({
    businessIncome: 1000,
    deductibleExpenses: 5000,
    hstGstCollected: 130,
    hstGstPaid: 0,
    reservePercent: 0.25,
  });
  assert.equal(r.netBusinessIncome, -4000);
  assert.equal(r.netHstGst, 130);
  // max(0, -4000) * 0.25 = 0 + 130 = 130
  assert.equal(r.reserveTarget, 130);
});

test('composeTaxReserve: net negative HST/GST clips to zero', () => {
  // ITC > HST collected → no HST remittance owed.
  const r = composeTaxReserve({
    businessIncome: 10000,
    deductibleExpenses: 0,
    hstGstCollected: 100,
    hstGstPaid: 500,
    reservePercent: 0.2,
  });
  // 10000 * 0.2 = 2000 + max(0, -400) = 2000
  assert.equal(r.reserveTarget, 2000);
  assert.equal(r.netHstGst, -400);
});

test('composeTaxReserve: zero percent yields HST-only reserve', () => {
  // AC: "User can configure reserve percentage" — 0% is a legitimate
  // value (e.g. household offsets tax via spouse income).
  const r = composeTaxReserve({
    businessIncome: 5000,
    deductibleExpenses: 1000,
    hstGstCollected: 520,
    hstGstPaid: 100,
    reservePercent: 0,
  });
  assert.equal(r.reserveTarget, 420);
});

test('composeTaxReserve: rounds to two decimal places', () => {
  // 1234.567 * 0.25 = 308.64175 → 308.64
  const r = composeTaxReserve({
    businessIncome: 1234.567,
    deductibleExpenses: 0,
    hstGstCollected: 0,
    hstGstPaid: 0,
    reservePercent: 0.25,
  });
  assert.equal(r.reserveTarget, 308.64);
});

// ---- aggregateReserveRollups -------------------------------------------

function row(over: Partial<ReserveInputRow> = {}): ReserveInputRow {
  return {
    date: '2026-03-15',
    amount: '-100',
    currency: 'CAD',
    finalBusiness: true,
    deductiblePercent: null,
    hstGstAmount: null,
    ...over,
  };
}

test('aggregateReserveRollups: groups by (currency, period) and applies percent', () => {
  const rollup = aggregateReserveRollups(
    [
      row({ date: '2026-01-15', amount: '5000', hstGstAmount: '650' }), // Q1 income
      row({ date: '2026-02-15', amount: '-1000', hstGstAmount: '130' }), // Q1 expense
      row({ date: '2026-04-15', amount: '8000', hstGstAmount: '1040' }), // Q2 income
    ],
    'quarterly',
    new Map([['CAD', 0.25]]),
    0.25,
  );
  assert.equal(rollup.length, 2);
  const q1 = rollup.find((r) => r.period === '2026-Q1')!;
  const q2 = rollup.find((r) => r.period === '2026-Q2')!;
  assert.equal(q1.components.businessIncome, 5000);
  assert.equal(q1.components.deductibleExpenses, 1000); // default 100% deductible
  assert.equal(q1.components.hstGstCollected, 650);
  assert.equal(q1.components.hstGstPaid, 130);
  assert.equal(q1.netBusinessIncome, 4000);
  assert.equal(q1.netHstGst, 520);
  // 4000 * 0.25 = 1000 + 520 = 1520
  assert.equal(q1.reserveTarget, 1520);
  assert.equal(q2.components.businessIncome, 8000);
  assert.equal(q2.reserveTarget, 8000 * 0.25 + 1040);
});

test('aggregateReserveRollups: non-business rows ignored', () => {
  // AC: "Tax-relevant transactions can be reviewed" — only business txns
  // feed the reserve. Personal income and expenses must not move the dial.
  const rollup = aggregateReserveRollups(
    [
      row({ date: '2026-03-01', amount: '5000', finalBusiness: false }),
      row({ date: '2026-03-15', amount: '-200', finalBusiness: false }),
      row({ date: '2026-03-20', amount: '1000' }), // this one counts
    ],
    'quarterly',
    new Map(),
    0.25,
  );
  assert.equal(rollup.length, 1);
  assert.equal(rollup[0].components.businessIncome, 1000);
  assert.equal(rollup[0].reserveTarget, 250);
});

test('aggregateReserveRollups: deductible percent applies to expenses', () => {
  const rollup = aggregateReserveRollups(
    [
      row({ amount: '2000' }), // income
      // 50% deductible meals: 400 deducted out of 1000 expense.
      row({ amount: '-1000', deductiblePercent: '0.5000' }),
    ],
    'quarterly',
    new Map(),
    0.25,
  );
  assert.equal(rollup[0].components.businessIncome, 2000);
  assert.equal(rollup[0].components.deductibleExpenses, 500);
  // net = 1500, reserve = 1500 * 0.25 = 375
  assert.equal(rollup[0].reserveTarget, 375);
});

test('aggregateReserveRollups: separates currencies', () => {
  // AC: "Calculate suggested reserve by period and currency"
  const rollup = aggregateReserveRollups(
    [
      row({ amount: '1000', currency: 'CAD' }),
      row({ amount: '500', currency: 'USD' }),
    ],
    'quarterly',
    new Map([
      ['CAD', 0.25],
      ['USD', 0.30],
    ]),
    0.20,
  );
  const cad = rollup.find((r) => r.currency === 'CAD')!;
  const usd = rollup.find((r) => r.currency === 'USD')!;
  assert.equal(cad.reservePercent, 0.25);
  assert.equal(cad.reserveTarget, 250);
  assert.equal(usd.reservePercent, 0.30);
  assert.equal(usd.reserveTarget, 150);
});

test('aggregateReserveRollups: missing currency falls back to default percent', () => {
  const rollup = aggregateReserveRollups(
    [row({ amount: '1000', currency: 'EUR' })],
    'quarterly',
    new Map(),
    0.15,
  );
  assert.equal(rollup[0].reservePercent, 0.15);
  assert.equal(rollup[0].reserveTarget, 150);
});

test('aggregateReserveRollups: monthly periodicity buckets into YYYY-MM', () => {
  const rollup = aggregateReserveRollups(
    [
      row({ date: '2026-01-15', amount: '1000' }),
      row({ date: '2026-02-15', amount: '2000' }),
      row({ date: '2026-02-28', amount: '500' }),
    ],
    'monthly',
    new Map([['CAD', 0.2]]),
    0.2,
  );
  assert.equal(rollup.length, 2);
  assert.equal(rollup.find((r) => r.period === '2026-01')!.components.businessIncome, 1000);
  assert.equal(rollup.find((r) => r.period === '2026-02')!.components.businessIncome, 2500);
});

test('aggregateReserveRollups: sort order is (currency asc, period asc)', () => {
  const rollup = aggregateReserveRollups(
    [
      row({ date: '2026-04-15', currency: 'USD', amount: '100' }),
      row({ date: '2026-01-15', currency: 'USD', amount: '100' }),
      row({ date: '2026-04-15', currency: 'CAD', amount: '100' }),
      row({ date: '2026-01-15', currency: 'CAD', amount: '100' }),
    ],
    'quarterly',
    new Map(),
    0.2,
  );
  assert.deepEqual(
    rollup.map((r) => `${r.currency}-${r.period}`),
    ['CAD-2026-Q1', 'CAD-2026-Q2', 'USD-2026-Q1', 'USD-2026-Q2'],
  );
});

test('aggregateReserveRollups: empty input returns empty array', () => {
  assert.deepEqual(aggregateReserveRollups([], 'quarterly', new Map(), 0.25), []);
});

// ---- validateReservePatch ----------------------------------------------

test('validateReservePatch: accepts valid percent and note', () => {
  const r = validateReservePatch({ reservePercent: 0.3, note: 'Federal + ON' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.patch.reservePercent, '0.3000');
    assert.equal(r.patch.note, 'Federal + ON');
  }
});

test('validateReservePatch: rejects percent below 0', () => {
  const r = validateReservePatch({ reservePercent: -0.1 });
  assert.equal(r.ok, false);
});

test('validateReservePatch: rejects percent above 1', () => {
  const r = validateReservePatch({ reservePercent: 1.5 });
  assert.equal(r.ok, false);
});

test('validateReservePatch: accepts 0 and 1 (edges of the range)', () => {
  assert.equal(validateReservePatch({ reservePercent: 0 }).ok, true);
  assert.equal(validateReservePatch({ reservePercent: 1 }).ok, true);
});

test('validateReservePatch: empty note coerces to null', () => {
  const r = validateReservePatch({ note: '' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.patch.note, null);
});

test('validateReservePatch: null note stays null', () => {
  const r = validateReservePatch({ note: null });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.patch.note, null);
});

test('validateReservePatch: long note truncated to 4000 chars', () => {
  const r = validateReservePatch({ note: 'x'.repeat(5000) });
  assert.equal(r.ok, true);
  if (r.ok && r.patch.note) assert.equal(r.patch.note.length, 4000);
});

test('validateReservePatch: ignores unknown keys', () => {
  const r = validateReservePatch({ garbage: true, reservePercent: 0.25 });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.patch.reservePercent, '0.2500');
});

test('validateReservePatch: empty body is OK (no-op patch)', () => {
  const r = validateReservePatch({});
  assert.equal(r.ok, true);
});
