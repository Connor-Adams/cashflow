/**
 * Unit tests for the pure helpers in routes/businessTax: scope/where, summary
 * aggregator, and CSV serializer. These exercise correctness without spinning
 * up the full integration stack (covered separately).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Op } from 'sequelize';
import {
  parseTaxScope,
  scopeWhere,
  dateRangeWhere,
  aggregateTaxSummary,
  csvEscape,
  rowsToTaxCsv,
  type TaxSummaryInputRow,
  type TaxExportRow,
} from './businessTax';

// ---- parseTaxScope ------------------------------------------------------

test('parseTaxScope: defaults to business when missing', () => {
  assert.equal(parseTaxScope(undefined), 'business');
});

test('parseTaxScope: accepts known values', () => {
  assert.equal(parseTaxScope('personal'), 'personal');
  assert.equal(parseTaxScope('shared'), 'shared');
  assert.equal(parseTaxScope('business'), 'business');
  assert.equal(parseTaxScope('all'), 'all');
});

test('parseTaxScope: normalizes case', () => {
  assert.equal(parseTaxScope('BUSINESS'), 'business');
  assert.equal(parseTaxScope('Personal'), 'personal');
});

test('parseTaxScope: falls back on unknown', () => {
  assert.equal(parseTaxScope('garbage'), 'business');
  assert.equal(parseTaxScope('garbage', 'all'), 'all');
});

// ---- scopeWhere ---------------------------------------------------------

test('scopeWhere personal: business=false AND split=me', () => {
  const w = scopeWhere('personal') as Record<string, unknown>;
  assert.equal(w.finalBusiness, false);
  assert.equal(w.finalSplitType, 'me');
});

test('scopeWhere shared: business=false AND split!=me', () => {
  const w = scopeWhere('shared') as Record<string, unknown>;
  assert.equal(w.finalBusiness, false);
  assert.deepEqual(w.finalSplitType, { [Op.ne]: 'me' });
});

test('scopeWhere business: business=true', () => {
  const w = scopeWhere('business') as Record<string, unknown>;
  assert.equal(w.finalBusiness, true);
  assert.equal(w.finalSplitType, undefined);
});

test('scopeWhere all: empty where', () => {
  assert.deepEqual(scopeWhere('all'), {});
});

// ---- dateRangeWhere -----------------------------------------------------

test('dateRangeWhere: empty when both missing', () => {
  assert.deepEqual(dateRangeWhere(), {});
});

test('dateRangeWhere: from only', () => {
  const w = dateRangeWhere('2026-01-01') as Record<string, unknown>;
  assert.deepEqual(w.date, { [Op.gte]: '2026-01-01' });
});

test('dateRangeWhere: to only', () => {
  const w = dateRangeWhere(undefined, '2026-12-31') as Record<string, unknown>;
  assert.deepEqual(w.date, { [Op.lte]: '2026-12-31' });
});

test('dateRangeWhere: both', () => {
  const w = dateRangeWhere('2026-01-01', '2026-12-31') as Record<string, unknown>;
  assert.deepEqual(w.date, {
    [Op.gte]: '2026-01-01',
    [Op.lte]: '2026-12-31',
  });
});

// ---- aggregateTaxSummary ------------------------------------------------

function row(over: Partial<TaxSummaryInputRow> = {}): TaxSummaryInputRow {
  return {
    amount: '-100',
    currency: 'CAD',
    finalBusiness: true,
    deductiblePercent: null,
    hstGstAmount: null,
    reviewedForTax: false,
    ...over,
  };
}

test('aggregateTaxSummary: business row with no metadata defaults to 100% deductible', () => {
  const rollup = aggregateTaxSummary([row()]);
  assert.equal(rollup.length, 1);
  assert.equal(rollup[0].gross, '100.00');
  assert.equal(rollup[0].deductibleEstimate, '100.00');
  assert.equal(rollup[0].hstGstEstimate, '0.00');
  assert.equal(rollup[0].transactionCount, 1);
  assert.equal(rollup[0].reviewedCount, 0);
});

test('aggregateTaxSummary: non-business row with no metadata defaults to 0% deductible', () => {
  const rollup = aggregateTaxSummary([
    row({ finalBusiness: false }),
  ]);
  assert.equal(rollup[0].gross, '100.00');
  assert.equal(rollup[0].deductibleEstimate, '0.00');
});

test('aggregateTaxSummary: declared deductible percent wins over default', () => {
  const rollup = aggregateTaxSummary([
    row({ deductiblePercent: '0.5000' }),
  ]);
  assert.equal(rollup[0].deductibleEstimate, '50.00');
});

test('aggregateTaxSummary: HST/GST amount aggregates', () => {
  const rollup = aggregateTaxSummary([
    row({ amount: '-113', hstGstAmount: '13.00' }),
    row({ amount: '-226', hstGstAmount: '26.00' }),
  ]);
  assert.equal(rollup[0].gross, '339.00');
  assert.equal(rollup[0].hstGstEstimate, '39.00');
});

test('aggregateTaxSummary: positive amounts (refunds/credits) are skipped', () => {
  const rollup = aggregateTaxSummary([
    row({ amount: '-100' }),
    row({ amount: '50' }),
  ]);
  assert.equal(rollup[0].gross, '100.00');
  assert.equal(rollup[0].transactionCount, 1);
});

test('aggregateTaxSummary: groups by currency', () => {
  const rollup = aggregateTaxSummary([
    row({ amount: '-100', currency: 'CAD' }),
    row({ amount: '-50', currency: 'USD' }),
    row({ amount: '-25', currency: 'CAD' }),
  ]);
  assert.equal(rollup.length, 2);
  const cad = rollup.find((r) => r.currency === 'CAD')!;
  const usd = rollup.find((r) => r.currency === 'USD')!;
  assert.equal(cad.gross, '125.00');
  assert.equal(usd.gross, '50.00');
});

test('aggregateTaxSummary: counts reviewed rows separately', () => {
  const rollup = aggregateTaxSummary([
    row({ reviewedForTax: true }),
    row({ reviewedForTax: false }),
    row({ reviewedForTax: true }),
  ]);
  assert.equal(rollup[0].transactionCount, 3);
  assert.equal(rollup[0].reviewedCount, 2);
});

test('aggregateTaxSummary: declared 0% deductible overrides business default', () => {
  const rollup = aggregateTaxSummary([
    row({ deductiblePercent: '0.0000', finalBusiness: true }),
  ]);
  assert.equal(rollup[0].deductibleEstimate, '0.00');
});

// ---- csvEscape ----------------------------------------------------------

test('csvEscape: null/undefined become empty string', () => {
  assert.equal(csvEscape(null), '');
  assert.equal(csvEscape(undefined), '');
});

test('csvEscape: plain values pass through', () => {
  assert.equal(csvEscape('hello'), 'hello');
  assert.equal(csvEscape(42), '42');
});

test('csvEscape: values with commas get quoted', () => {
  assert.equal(csvEscape('hello, world'), '"hello, world"');
});

test('csvEscape: values with quotes get escaped + quoted', () => {
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
});

test('csvEscape: values with newlines get quoted', () => {
  assert.equal(csvEscape('line1\nline2'), '"line1\nline2"');
  assert.equal(csvEscape('line1\r\nline2'), '"line1\r\nline2"');
});

// ---- rowsToTaxCsv -------------------------------------------------------

function exportRow(over: Partial<TaxExportRow> = {}): TaxExportRow {
  return {
    id: 1,
    date: '2026-01-15',
    merchant: 'Office Depot',
    accountName: 'Visa',
    currency: 'CAD',
    amount: '-113.00',
    finalCategory: 'Office',
    finalBusiness: true,
    finalSplitType: 'me',
    taxTagName: 'Supplies',
    deductiblePercent: '1.0000',
    deductibleAmount: '113.00',
    hstGstAmount: '13.00',
    receiptRequired: true,
    hasReceipt: true,
    reviewedForTax: true,
    notes: null,
    ...over,
  };
}

test('rowsToTaxCsv: header is the canonical tax-ready set', () => {
  const csv = rowsToTaxCsv([]);
  assert.equal(
    csv,
    'id,date,merchant,account,currency,amount,category,business,split,tax_tag,deductible_percent,deductible_amount,hst_gst_amount,receipt_required,has_receipt,reviewed_for_tax,notes',
  );
});

test('rowsToTaxCsv: one row renders all columns in order', () => {
  const csv = rowsToTaxCsv([exportRow()]);
  const lines = csv.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(
    lines[1],
    '1,2026-01-15,Office Depot,Visa,CAD,-113.00,Office,true,me,Supplies,1.0000,113.00,13.00,true,true,true,',
  );
});

test('rowsToTaxCsv: commas in merchant/notes are escaped', () => {
  const csv = rowsToTaxCsv([
    exportRow({ merchant: 'Acme, Inc.', notes: 'first\nsecond' }),
  ]);
  // Splitting by \n would corrupt the multi-line quoted note field, so check
  // the raw CSV string includes both escaped forms.
  assert.match(csv, /"Acme, Inc\."/);
  assert.match(csv, /"first\nsecond"/);
});
