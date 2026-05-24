/**
 * Unit tests for computeReceiptWarnings. Pure helper that diffs an
 * OCR-extracted receipt note against its matched transaction and returns
 * human-readable warnings when fields disagree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeReceiptWarnings } from '../src/util/receiptWarnings';

function makeTxn(over: Partial<{ amount: unknown; currency: string; date: string }> = {}) {
  return {
    amount: -42.5,
    currency: 'CAD',
    date: '2025-06-15',
    ...over,
  };
}

test('matching total/currency/date → no warnings', () => {
  const note = JSON.stringify({ total: 42.5, currency: 'CAD', date: '2025-06-15' });
  assert.deepEqual(computeReceiptWarnings(note, makeTxn()), []);
});

test('uppercases receipt currency before comparing', () => {
  // The route stores currency uppercased; the extracted JSON often arrives
  // lowercased from OCR. Equality should treat them the same.
  const note = JSON.stringify({ total: 42.5, currency: 'cad', date: '2025-06-15' });
  assert.deepEqual(computeReceiptWarnings(note, makeTxn()), []);
});

test('total differs by more than 0.02 → warning', () => {
  const note = JSON.stringify({ total: 43.0, currency: 'CAD', date: '2025-06-15' });
  const warnings = computeReceiptWarnings(note, makeTxn());
  assert.deepEqual(warnings, ['receipt total differs']);
});

test('total within 0.02 (penny rounding) → no total warning', () => {
  const note = JSON.stringify({ total: 42.51, currency: 'CAD', date: '2025-06-15' });
  assert.deepEqual(computeReceiptWarnings(note, makeTxn()), []);
});

test('currency differs → warning', () => {
  const note = JSON.stringify({ total: 42.5, currency: 'USD', date: '2025-06-15' });
  assert.deepEqual(computeReceiptWarnings(note, makeTxn()), [
    'receipt currency differs',
  ]);
});

test('date differs → warning', () => {
  const note = JSON.stringify({ total: 42.5, currency: 'CAD', date: '2025-06-14' });
  assert.deepEqual(computeReceiptWarnings(note, makeTxn()), ['receipt date differs']);
});

test('absolute value used when comparing to negative txn amount', () => {
  // Spend transactions carry negative amounts; receipts list positive totals.
  // The helper must abs the txn amount before subtracting.
  const note = JSON.stringify({ total: 42.5, currency: 'CAD', date: '2025-06-15' });
  assert.deepEqual(computeReceiptWarnings(note, makeTxn({ amount: -42.5 })), []);
});

test('non-string currency (extracted as number) is ignored, no warning', () => {
  // Defensive: OCR sometimes returns wrong-typed fields. The helper only
  // warns on currency mismatch when the extracted value is a string.
  const note = JSON.stringify({ total: 42.5, currency: 123, date: '2025-06-15' });
  assert.deepEqual(computeReceiptWarnings(note, makeTxn()), []);
});

test('non-string date is ignored, no date warning', () => {
  const note = JSON.stringify({ total: 42.5, currency: 'CAD', date: 1234567 });
  assert.deepEqual(computeReceiptWarnings(note, makeTxn()), []);
});

test('non-finite receipt total is ignored, no total warning', () => {
  const note = JSON.stringify({ total: 'not a number', currency: 'CAD', date: '2025-06-15' });
  assert.deepEqual(computeReceiptWarnings(note, makeTxn()), []);
});

test('unparseable JSON → caught, single "could not be read" warning', () => {
  assert.deepEqual(computeReceiptWarnings('{not valid', makeTxn()), [
    'receipt extract could not be read',
  ]);
});

test('multiple field mismatches accumulate in order: total, currency, date', () => {
  const note = JSON.stringify({ total: 100, currency: 'USD', date: '1999-01-01' });
  assert.deepEqual(computeReceiptWarnings(note, makeTxn()), [
    'receipt total differs',
    'receipt currency differs',
    'receipt date differs',
  ]);
});
