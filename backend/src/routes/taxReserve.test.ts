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
  convertReserveRowsToCad,
  type CadConverter,
  type ReserveInputRow,
} from './taxReserve';
import type { ToCadResult, ToCadSource } from '../fx/toCad';
import type { Decimal } from '../tax/util/decimal';

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
      row({ date: '2026-01-15', amount: '5000', hstGstAmount: '650', txnType: 'income' }), // Q1 income
      row({ date: '2026-02-15', amount: '-1000', hstGstAmount: '130' }), // Q1 expense
      row({ date: '2026-04-15', amount: '8000', hstGstAmount: '1040', txnType: 'income' }), // Q2 income
    ],
    'quarterly',
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
      row({ date: '2026-03-01', amount: '5000', finalBusiness: false, txnType: 'income' }),
      row({ date: '2026-03-15', amount: '-200', finalBusiness: false }),
      row({ date: '2026-03-20', amount: '1000', txnType: 'income' }), // this one counts
    ],
    'quarterly',
    0.25,
  );
  assert.equal(rollup.length, 1);
  assert.equal(rollup[0].components.businessIncome, 1000);
  assert.equal(rollup[0].reserveTarget, 250);
});

test('aggregateReserveRollups: deductible percent applies to expenses', () => {
  const rollup = aggregateReserveRollups(
    [
      row({ amount: '2000', txnType: 'income' }), // income
      // 50% deductible meals: 400 deducted out of 1000 expense.
      row({ amount: '-1000', deductiblePercent: '0.5000' }),
    ],
    'quarterly',
    0.25,
  );
  assert.equal(rollup[0].components.businessIncome, 2000);
  assert.equal(rollup[0].components.deductibleExpenses, 500);
  // net = 1500, reserve = 1500 * 0.25 = 375
  assert.equal(rollup[0].reserveTarget, 375);
});

test('aggregateReserveRollups: one CAD bucket per period, one percent', () => {
  // The reserve is a single CAD figure (Canadian tax is paid in CAD): rows
  // arrive already converted, so every period has exactly one bucket.
  const rollup = aggregateReserveRollups(
    [
      row({ amount: '1000', txnType: 'income' }),
      row({ amount: '500', txnType: 'income', sourceCurrency: 'USD' }),
      row({ amount: '-300', txnType: 'purchase' }),
    ],
    'quarterly',
    0.3,
  );
  assert.equal(rollup.length, 1);
  assert.equal(rollup[0].currency, 'CAD');
  assert.equal(rollup[0].reservePercent, 0.3);
  assert.equal(rollup[0].components.businessIncome, 1500);
  // (1500 - 300) x 0.3 = 360
  assert.equal(rollup[0].reserveTarget, 360);
  assert.deepEqual(rollup[0].sourceCurrencies, ['CAD', 'USD']);
});

test('aggregateReserveRollups: refuses an unconverted non-CAD row', () => {
  // Summing USD into a CAD bucket would be silently wrong; the loader must
  // convert first.
  assert.throws(
    () => aggregateReserveRollups([row({ amount: '1000', currency: 'USD', txnType: 'income' })], 'quarterly', 0.25),
    /convert/i,
  );
});

// ---- convertReserveRowsToCad -------------------------------------------

/** Fake converter: fixed rate per currency, records each call. */
function fakeConverter(
  rates: Record<string, { rate: string; ratedDate?: string; source?: ToCadSource }>,
  calls: string[] = [],
): CadConverter {
  return async (amount: Decimal, currency: string, date: string): Promise<ToCadResult> => {
    calls.push(`${currency}|${date}`);
    if (currency === 'CAD') return { cad: amount, rate: 1, ratedDate: date, source: 'cad_identity' };
    const r = rates[currency];
    if (!r) throw new Error(`FX rate missing for ${currency}→CAD on/before ${date} (no rows for pair at all)`);
    return {
      cad: amount.times(r.rate),
      rate: Number(r.rate),
      ratedDate: r.ratedDate ?? date,
      source: r.source ?? 'cached',
    };
  };
}

test('convertReserveRowsToCad: converts amount, business portion and HST at the row date rate', async () => {
  const { rows, warnings } = await convertReserveRowsToCad(
    [
      row({
        date: '2025-06-10',
        amount: '1000',
        currency: 'USD',
        businessAmount: '800',
        hstGstAmount: '50',
        txnType: 'income',
      }),
    ],
    fakeConverter({ USD: { rate: '1.37' } }),
  );
  assert.deepEqual(warnings, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].currency, 'CAD');
  assert.equal(rows[0].sourceCurrency, 'USD');
  assert.equal(Number(rows[0].amount), 1370);
  assert.equal(Number(rows[0].businessAmount), 1096);
  assert.equal(Number(rows[0].hstGstAmount), 68.5);
  assert.equal(rows[0].date, '2025-06-10');
});

test('convertReserveRowsToCad: CAD rows pass through untouched', async () => {
  const calls: string[] = [];
  const input = row({ amount: '-250', hstGstAmount: '32.5' });
  const { rows } = await convertReserveRowsToCad([input], fakeConverter({}, calls));
  assert.equal(rows[0].amount, '-250');
  assert.equal(rows[0].hstGstAmount, '32.5');
  assert.equal(rows[0].sourceCurrency, 'CAD');
  assert.deepEqual(calls, []);
});

test('convertReserveRowsToCad: one rate lookup per (currency, date)', async () => {
  const calls: string[] = [];
  await convertReserveRowsToCad(
    [
      row({ date: '2025-06-10', amount: '100', currency: 'USD', txnType: 'income' }),
      row({ date: '2025-06-10', amount: '200', currency: 'USD', txnType: 'income' }),
      row({ date: '2025-06-11', amount: '300', currency: 'USD', txnType: 'income' }),
    ],
    fakeConverter({ USD: { rate: '1.35' } }, calls),
  );
  assert.deepEqual(calls.sort(), ['USD|2025-06-10', 'USD|2025-06-11']);
});

test('convertReserveRowsToCad: a stale substituted rate surfaces as a warning', async () => {
  const { warnings } = await convertReserveRowsToCad(
    [row({ date: '2025-06-10', amount: '100', currency: 'USD', txnType: 'income' })],
    fakeConverter({ USD: { rate: '1.3', ratedDate: '2025-05-01', source: 'fallback_nearest' } }),
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /USD→CAD/);
  assert.match(warnings[0], /2025-06-10/);
  assert.match(warnings[0], /2025-05-01/);
});

test('convertReserveRowsToCad: a future-dated rate is never used silently', async () => {
  const { rows, warnings } = await convertReserveRowsToCad(
    [row({ date: '2020-01-02', amount: '100', currency: 'USD', txnType: 'income' })],
    fakeConverter({ USD: { rate: '1.4', ratedDate: '2021-05-26', source: 'fallback_any' } }),
  );
  assert.equal(Number(rows[0].amount), 140);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /AFTER the transaction/);
  assert.match(warnings[0], /2021-05-26/);
});

test('convertReserveRowsToCad: a currency with no rate at all is left out with a warning', async () => {
  const { rows, warnings } = await convertReserveRowsToCad(
    [
      row({ amount: '100', currency: 'GBP', txnType: 'income' }),
      row({ amount: '200', currency: 'GBP', txnType: 'income' }),
      row({ amount: '50', txnType: 'income' }),
    ],
    fakeConverter({}),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, '50');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /GBP/);
  assert.match(warnings[0], /2 business transaction/);
});

test('convert then aggregate: USD income nets against CAD expenses in one CAD figure', async () => {
  // The prod shape this fixes: USD client income, CAD deductible expenses.
  // Per-currency buckets reserved 25% of the gross USD and let the CAD
  // expenses go to waste in a separate loss bucket.
  const { rows } = await convertReserveRowsToCad(
    [
      row({ date: '2025-03-01', amount: '10000', currency: 'USD', txnType: 'income' }),
      row({ date: '2025-03-05', amount: '-2000', txnType: 'purchase' }),
    ],
    fakeConverter({ USD: { rate: '1.4' } }),
  );
  const rollup = aggregateReserveRollups(rows, 'annual', 0.25);
  assert.equal(rollup.length, 1);
  assert.equal(rollup[0].components.businessIncome, 14000);
  assert.equal(rollup[0].components.deductibleExpenses, 2000);
  // (14000 - 2000) x 0.25 = 3000
  assert.equal(rollup[0].reserveTarget, 3000);
});

test('aggregateReserveRollups: monthly periodicity buckets into YYYY-MM', () => {
  const rollup = aggregateReserveRollups(
    [
      row({ date: '2026-01-15', amount: '1000', txnType: 'income' }),
      row({ date: '2026-02-15', amount: '2000', txnType: 'income' }),
      row({ date: '2026-02-28', amount: '500', txnType: 'income' }),
    ],
    'monthly',
    0.2,
  );
  assert.equal(rollup.length, 2);
  assert.equal(rollup.find((r) => r.period === '2026-01')!.components.businessIncome, 1000);
  assert.equal(rollup.find((r) => r.period === '2026-02')!.components.businessIncome, 2500);
});

test('aggregateReserveRollups: sorted by period', () => {
  const rollup = aggregateReserveRollups(
    [
      row({ date: '2026-07-15', amount: '100', txnType: 'income' }),
      row({ date: '2026-01-15', amount: '100', txnType: 'income' }),
      row({ date: '2026-04-15', amount: '100', txnType: 'income' }),
    ],
    'quarterly',
    0.2,
  );
  assert.deepEqual(rollup.map((r) => r.period), ['2026-Q1', '2026-Q2', '2026-Q3']);
});

test('aggregateReserveRollups: empty input returns empty array', () => {
  assert.deepEqual(aggregateReserveRollups([], 'quarterly', 0.25), []);
});

test('aggregateReserveRollups: an untyped positive business deposit is not income', () => {
  // The dashboard routes an unsignaled deposit to 'skip' — it is a transfer,
  // loan movement or owner contribution far more often than revenue.
  const rollup = aggregateReserveRollups(
    [
      row({ amount: '1000', txnType: 'income' }),
      row({ amount: '4000', txnType: null, merchantRaw: 'DEPOSIT' }),
      row({ amount: '2500', txnType: 'unknown', merchantRaw: 'MOBILE DEPOSIT' }),
    ],
    'quarterly',
    0.25,
  );
  assert.equal(rollup[0].components.businessIncome, 1000);
  assert.equal(rollup[0].reserveTarget, 250);
});

test('aggregateReserveRollups: payment and transfer legs are neither income nor expense', () => {
  // businessTax.ts documents that positive business rows include payments and
  // transfers; the card-side payment leg and an owner transfer are not revenue,
  // and the chequing-side legs are not deductible expenses.
  const rollup = aggregateReserveRollups(
    [
      row({ amount: '3000', txnType: 'income' }),
      row({ amount: '1500', txnType: 'payment', merchantRaw: 'PAYMENT THANK YOU' }),
      row({ amount: '2000', txnType: 'transfer' }),
      row({ amount: '-1500', txnType: 'payment' }),
      row({ amount: '-700', txnType: 'transfer' }),
      row({ amount: '-400', txnType: 'purchase' }),
    ],
    'quarterly',
    0.25,
  );
  assert.equal(rollup[0].components.businessIncome, 3000);
  assert.equal(rollup[0].components.deductibleExpenses, 400);
  assert.equal(rollup[0].netBusinessIncome, 2600);
});

test('aggregateReserveRollups: a business refund nets against expenses, not income', () => {
  // A $300 refund of a $1,000 business purchase leaves $700 of deductible
  // expense; the refunded HST likewise reduces the input tax credit.
  const rollup = aggregateReserveRollups(
    [
      row({ amount: '5000', txnType: 'income', hstGstAmount: '650' }),
      row({ amount: '-1000', txnType: 'purchase', hstGstAmount: '130' }),
      row({ amount: '300', txnType: 'refund', hstGstAmount: '39' }),
    ],
    'quarterly',
    0.25,
  );
  const c = rollup[0].components;
  assert.equal(c.businessIncome, 5000);
  assert.equal(c.deductibleExpenses, 700);
  assert.equal(c.hstGstCollected, 650);
  assert.equal(c.hstGstPaid, 91);
  assert.equal(rollup[0].netBusinessIncome, 4300);
});

test('aggregateReserveRollups: an untyped positive with refund text nets as a refund', () => {
  // Same merchant-text fallback the dashboard's classifyPositiveAmount uses.
  const rollup = aggregateReserveRollups(
    [
      row({ amount: '-200', txnType: 'purchase' }),
      row({ amount: '50', txnType: null, merchantRaw: 'AMAZON REFUND' }),
    ],
    'quarterly',
    0.25,
  );
  assert.equal(rollup[0].components.businessIncome, 0);
  assert.equal(rollup[0].components.deductibleExpenses, 150);
});

test('aggregateReserveRollups: rows on an investment account are ignored', () => {
  const rollup = aggregateReserveRollups(
    [
      row({ amount: '1000', txnType: 'income' }),
      row({ amount: '9000', txnType: 'income', accountType: 'investment' }),
      row({ amount: '-5000', txnType: 'purchase', accountType: 'investment' }),
    ],
    'quarterly',
    0.25,
  );
  assert.equal(rollup[0].components.businessIncome, 1000);
  assert.equal(rollup[0].components.deductibleExpenses, 0);
});

test('aggregateReserveRollups: net loss clips to zero before percent; HST still owed', () => {
  // A loss period must never suggest a negative reserve.
  const rollup = aggregateReserveRollups(
    [
      row({ amount: '1000', hstGstAmount: '130', txnType: 'income' }),
      row({ amount: '-5000', txnType: 'purchase' }),
    ],
    'quarterly',
    0.25,
  );
  assert.equal(rollup[0].netBusinessIncome, -4000);
  assert.equal(rollup[0].netHstGst, 130);
  // max(0, -4000) * 0.25 = 0 + 130 = 130
  assert.equal(rollup[0].reserveTarget, 130);
});

test('aggregateReserveRollups: net negative HST/GST clips to zero', () => {
  // ITC > HST collected → no HST remittance owed.
  const rollup = aggregateReserveRollups(
    [
      row({ amount: '10000', hstGstAmount: '100', txnType: 'income' }),
      row({ amount: '-1000', hstGstAmount: '500', txnType: 'purchase' }),
    ],
    'quarterly',
    0.2,
  );
  assert.equal(rollup[0].netHstGst, -400);
  // 9000 * 0.2 = 1800 + max(0, -400) = 1800
  assert.equal(rollup[0].reserveTarget, 1800);
});

test('aggregateReserveRollups: a partly-business purchase deducts only its business portion', () => {
  // $1,000 purchase of which $300 is business (item-level split, as the
  // dashboard's business tile counts it). Only $300 is deductible and only
  // 30% of the $130 HST is an input tax credit.
  const rollup = aggregateReserveRollups(
    [
      row({ amount: '5000', txnType: 'income' }),
      row({ amount: '-1000', businessAmount: '-300', hstGstAmount: '130' }),
    ],
    'quarterly',
    0.25,
  );
  const c = rollup[0].components;
  assert.equal(c.deductibleExpenses, 300);
  assert.equal(c.hstGstPaid, 39);
  assert.equal(rollup[0].netBusinessIncome, 4700);
});

test('aggregateReserveRollups: deductible percent applies on top of the business portion', () => {
  // $300 business portion of a $1,000 meal, 50% deductible → $150.
  const rollup = aggregateReserveRollups(
    [row({ amount: '-1000', businessAmount: '-300', deductiblePercent: '0.5000' })],
    'quarterly',
    0.25,
  );
  assert.equal(rollup[0].components.deductibleExpenses, 150);
});

test('aggregateReserveRollups: a refund of a partly-business purchase nets only its business portion', () => {
  const rollup = aggregateReserveRollups(
    [
      row({ amount: '-1000', businessAmount: '-300', hstGstAmount: '130' }),
      row({ amount: '100', txnType: 'refund', businessAmount: '30', hstGstAmount: '13' }),
    ],
    'quarterly',
    0.25,
  );
  const c = rollup[0].components;
  assert.equal(c.deductibleExpenses, 270);
  assert.equal(c.hstGstPaid, 35.1);
});

test('aggregateReserveRollups: a zero business portion deducts nothing', () => {
  const rollup = aggregateReserveRollups(
    [row({ amount: '-1000', businessAmount: '0', hstGstAmount: '130' })],
    'quarterly',
    0.25,
  );
  assert.equal(rollup[0].components.deductibleExpenses, 0);
  assert.equal(rollup[0].components.hstGstPaid, 0);
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
