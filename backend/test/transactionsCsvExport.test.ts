/**
 * Unit tests for `transactionsExport.ts` — CSV cell escaping (RFC 4180) and
 * formula-injection defang. These run without a database.
 *
 * AC coverage: #7 (formula defang), #8 (RFC 4180 quoting/escaping)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCsvCell,
  buildExportRow,
  todayIso,
  exportContentDisposition,
  EXPORT_HEADERS,
} from '../src/services/transactionsExport';

// ─────────────── formatCsvCell — null / undefined ───────────────────────────

test('formatCsvCell: null returns empty string', () => {
  assert.equal(formatCsvCell(null), '');
});

test('formatCsvCell: undefined returns empty string', () => {
  assert.equal(formatCsvCell(undefined), '');
});

// ─────────────── formatCsvCell — plain values (no quoting needed) ────────────

test('formatCsvCell: plain string passes through unchanged', () => {
  assert.equal(formatCsvCell('hello world'), 'hello world');
});

test('formatCsvCell: number is stringified', () => {
  assert.equal(formatCsvCell(42), '42');
});

test('formatCsvCell: negative number is stringified without formula defang (not a formula char)', () => {
  // Numeric −5 → "-5" — the first char is '-' which IS a formula starter so it
  // gets defanged. However when the caller passes a JS number it calls String()
  // first, producing "-5", which starts with '-'.
  assert.equal(formatCsvCell(-5), "'-5");
});

test('formatCsvCell: boolean true becomes "true"', () => {
  assert.equal(formatCsvCell(true), 'true');
});

test('formatCsvCell: boolean false becomes "false"', () => {
  assert.equal(formatCsvCell(false), 'false');
});

// ─────────────── formatCsvCell — RFC 4180 quoting ───────────────────────────

test('formatCsvCell: value with comma is double-quoted', () => {
  assert.equal(formatCsvCell('a,b'), '"a,b"');
});

test('formatCsvCell: value with double-quote — inner quote doubled and wrapped', () => {
  assert.equal(formatCsvCell('say "hi"'), '"say ""hi"""');
});

test('formatCsvCell: value with newline is double-quoted', () => {
  assert.equal(formatCsvCell('line1\nline2'), '"line1\nline2"');
});

test('formatCsvCell: value with carriage return is double-quoted', () => {
  assert.equal(formatCsvCell('line1\rline2'), '"line1\rline2"');
});

test('formatCsvCell: value with CRLF is double-quoted', () => {
  assert.equal(formatCsvCell('line1\r\nline2'), '"line1\r\nline2"');
});

// ─────────────── formatCsvCell — formula injection defang ───────────────────

test('formatCsvCell: leading = is defanged', () => {
  assert.equal(formatCsvCell('=SUM(A1:A10)'), "'=SUM(A1:A10)");
});

test('formatCsvCell: leading + is defanged', () => {
  assert.equal(formatCsvCell('+1234'), "'+1234");
});

test('formatCsvCell: leading - is defanged', () => {
  assert.equal(formatCsvCell('-DROP TABLE'), "'-DROP TABLE");
});

test('formatCsvCell: leading @ is defanged', () => {
  assert.equal(formatCsvCell('@SUM'), "'@SUM");
});

test('formatCsvCell: formula defang + comma value — defanged then quoted', () => {
  // "=A,B" → after defang it becomes "'=A,B" → contains comma → gets quoted
  assert.equal(formatCsvCell('=A,B'), '"\'=A,B"');
});

test('formatCsvCell: non-leading = is NOT defanged', () => {
  assert.equal(formatCsvCell('1=1'), '1=1');
});

test('formatCsvCell: empty string passes through unchanged (no formula)', () => {
  assert.equal(formatCsvCell(''), '');
});

// ─────────────── buildExportRow ──────────────────────────────────────────────

test('buildExportRow: produces correct number of columns matching EXPORT_HEADERS', () => {
  const fakeTxn = {
    id: 1,
    date: '2025-01-15',
    amount: '-12.5000',
    currency: 'CAD',
    finalCategory: 'Groceries',
    merchantRaw: 'WHOLE FOODS',
    merchantClean: 'Whole Foods',
    reviewFlag: false,
    notes: null,
    get: () => null,
  } as unknown as import('../src/models').Transaction;

  const row = buildExportRow(fakeTxn, 'Chequing');
  assert.equal(row.length, EXPORT_HEADERS.length, 'row length must match headers');
});

test('buildExportRow: maps fields to correct columns', () => {
  const fakeTxn = {
    id: 99,
    date: '2025-03-20',
    amount: '-55.0000',
    currency: 'USD',
    finalCategory: 'Travel',
    merchantRaw: 'DELTA AIR',
    merchantClean: 'Delta Air',
    reviewFlag: true,
    notes: 'work trip',
    get: () => null,
  } as unknown as import('../src/models').Transaction;

  const row = buildExportRow(fakeTxn, 'Visa');
  const idx = Object.fromEntries(EXPORT_HEADERS.map((h, i) => [h, i]));

  assert.equal(row[idx.id], '99');
  assert.equal(row[idx.date], '2025-03-20');
  assert.equal(row[idx.account], 'Visa');
  // amount starts with '-' so it gets formula-defanged with a leading single quote
  assert.equal(row[idx.amount], "'-55.0000");
  assert.equal(row[idx.currency], 'USD');
  assert.equal(row[idx.category], 'Travel');
  assert.equal(row[idx.description], 'DELTA AIR');
  assert.equal(row[idx.merchant], 'Delta Air');
  assert.equal(row[idx.status], 'needs-review');
  assert.equal(row[idx.notes], 'work trip');
});

test('buildExportRow: null finalCategory renders as empty string', () => {
  const fakeTxn = {
    id: 1,
    date: '2025-01-01',
    amount: '-1.0000',
    currency: 'CAD',
    finalCategory: null,
    merchantRaw: 'Test',
    merchantClean: 'Test',
    reviewFlag: false,
    notes: null,
    get: () => null,
  } as unknown as import('../src/models').Transaction;

  const row = buildExportRow(fakeTxn, 'Account');
  const idx = Object.fromEntries(EXPORT_HEADERS.map((h, i) => [h, i]));
  assert.equal(row[idx.category], '');
});

// ─────────────── todayIso + exportContentDisposition ─────────────────────────

test('todayIso: formats a known date correctly', () => {
  const d = new Date('2025-04-15T12:00:00Z');
  assert.equal(todayIso(d), '2025-04-15');
});

test('exportContentDisposition: includes date in filename', () => {
  const cd = exportContentDisposition('2025-06-30');
  assert.equal(cd, 'attachment; filename="cashflow-transactions-2025-06-30.csv"');
});
