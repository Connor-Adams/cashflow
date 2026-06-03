/**
 * Unit tests for the forecast income detector.
 *
 * Context (root cause of "the forecast doesn't think I'll ever earn another
 * dollar again"): the forecast auto-projects recurring EXPENSES from
 * transaction history but never recurring INCOME, and the user's real income
 * ("Direct deposit from CDG LABS INC") is tagged txn_type='transfer' — the
 * same tag as internal money-moves. So the discriminating signal is the
 * direct-deposit / payroll DESCRIPTION (or an explicit txn_type='income'),
 * NOT merchant-blind recurrence.
 *
 * These tests pin that discriminator: a payroll/direct-deposit inflow is
 * detected as income; an internal transfer of the same shape is NOT.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectRecurringIncome,
  type IncomeInputTxn,
} from '../src/forecast/detectIncome';

function inflow(
  merchant: string,
  amount: number,
  date: string,
  opts: { txnType?: string | null; currency?: string } = {},
): IncomeInputTxn {
  return {
    merchant,
    amount: Math.abs(amount),
    date,
    currency: opts.currency ?? 'CAD',
    txnType: opts.txnType ?? 'transfer',
  };
}

test('detects a recurring direct deposit as monthly income', () => {
  // Connor's actual data: two CDG payroll deposits, tagged txn_type=transfer,
  // lumpy amounts, ~3-week gap. The description is the signal.
  const txns: IncomeInputTxn[] = [
    inflow('Direct deposit from CDG LABS INC', 7229, '2026-04-09'),
    inflow('Direct deposit from CDG LABS INC', 14224, '2026-04-30'),
  ];
  const items = detectRecurringIncome(txns);
  assert.equal(items.length, 1, 'expected one detected income stream');
  const [item] = items;
  assert.match(item.source, /CDG LABS INC/i);
  assert.equal(item.currency, 'CAD');
  assert.equal(item.occurrences, 2);
  assert.ok(Math.abs(item.avgAmount - 10726.5) < 1e-6, `avgAmount was ${item.avgAmount}`);
  assert.equal(item.lastSeen, '2026-04-30');
  assert.equal(item.cadence, 'monthly');
  assert.ok(item.nextExpected > item.lastSeen, 'nextExpected must be after lastSeen');
});

test('does NOT treat internal transfers / self-payments as income', () => {
  // These are positive inflows into personal checking that are really the
  // user moving money between own accounts. None match a payroll signal and
  // none are txn_type=income, so the detector must skip them all.
  const txns: IncomeInputTxn[] = [
    inflow('From chequing account', 2120, '2026-01-04'),
    inflow('From chequing account', 2120, '2026-02-04'),
    inflow('From chequing account', 2120, '2026-03-04'),
    inflow('Interac e-Transfer® Received', 3396, '2026-01-31'),
    inflow('Interac e-Transfer® Received', 3396, '2026-02-28'),
    inflow('Interac e-Transfer® Received', 3396, '2026-03-31'),
    inflow('Transfer', 3714, '2026-02-14'),
    inflow('Transfer', 3714, '2026-03-14'),
  ];
  assert.deepEqual(detectRecurringIncome(txns), []);
});

test('detects income when txn_type is explicitly income, regardless of text', () => {
  const txns: IncomeInputTxn[] = [
    inflow('ACME PAYROLL', 2000, '2026-01-31', { txnType: 'income' }),
    inflow('ACME PAYROLL', 2000, '2026-02-28', { txnType: 'income' }),
  ];
  const items = detectRecurringIncome(txns);
  assert.equal(items.length, 1);
  assert.equal(items[0].occurrences, 2);
});

test('ignores negative (outflow) rows', () => {
  const txns: IncomeInputTxn[] = [
    { merchant: 'Direct deposit clawback', amount: -5000, date: '2026-01-15', currency: 'CAD', txnType: 'income' },
    { merchant: 'Direct deposit clawback', amount: -5000, date: '2026-02-15', currency: 'CAD', txnType: 'income' },
  ];
  assert.deepEqual(detectRecurringIncome(txns), []);
});

test('drops a single occurrence but honors minOccurrences override', () => {
  const single: IncomeInputTxn[] = [
    inflow('Payroll deposit', 3000, '2026-02-15', { txnType: 'income' }),
  ];
  assert.deepEqual(detectRecurringIncome(single), []);
  assert.deepEqual(detectRecurringIncome(single, { minOccurrences: 1 }).length, 1);
});

test('classifies a clean weekly cadence as weekly', () => {
  const txns: IncomeInputTxn[] = [
    inflow('Payroll', 800, '2026-03-06', { txnType: 'income' }),
    inflow('Payroll', 800, '2026-03-13', { txnType: 'income' }),
    inflow('Payroll', 800, '2026-03-20', { txnType: 'income' }),
  ];
  const [item] = detectRecurringIncome(txns);
  assert.equal(item.cadence, 'weekly');
});

test('separates streams by currency', () => {
  const txns: IncomeInputTxn[] = [
    inflow('Direct deposit from CDG LABS INC', 5000, '2026-01-31', { currency: 'CAD' }),
    inflow('Direct deposit from CDG LABS INC', 5000, '2026-02-28', { currency: 'CAD' }),
    inflow('Direct deposit from CDG LABS INC', 1000, '2026-01-31', { currency: 'USD' }),
    inflow('Direct deposit from CDG LABS INC', 1000, '2026-02-28', { currency: 'USD' }),
  ];
  const items = detectRecurringIncome(txns);
  assert.equal(items.length, 2);
});
