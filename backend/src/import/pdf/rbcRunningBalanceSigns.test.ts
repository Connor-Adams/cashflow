import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signByRunningBalance, type UnsignedRow } from './rbcRunningBalanceSigns.js';

function row(description: string, rawAmount: number, balance: number | null = null): UnsignedRow {
  return { date: '2026-10-02', description, rawAmount, balance };
}

const amounts = (rows: Array<{ amount: number }>) => rows.map((r) => r.amount);

test('a row with a balance is signed by its delta', () => {
  const { rows, parseErrors } = signByRunningBalance(
    [row('Loan interest', 189.03, 68.29), row('e-Transfer - Autodeposit', 150, 218.29)],
    257.32,
    218.29,
  );
  assert.deepEqual(amounts(rows), [-189.03, 150]);
  assert.deepEqual(parseErrors, []);
});

test('two balance-less rows before the next balance are solved together', () => {
  // The 6985 October 2026 statement: on 2 Oct RBC prints the balance only on
  // the last of three rows. The transfer used to default to a credit, which
  // broke reconciliation by exactly 2 × 17.93.
  const { rows, parseErrors } = signByRunningBalance(
    [
      row('ATM withdrawal - KF450729', 40, 178.29),
      row('Online Banking transfer - 4243', 17.93),
      row('Monthly fee', 4),
      row('Monthly Fee Rebate', 4, 160.36),
    ],
    218.29,
    160.36,
  );
  assert.deepEqual(amounts(rows), [-40, -17.93, -4, 4]);
  assert.deepEqual(parseErrors, []);
});

test('an offsetting fee and rebate are told apart by their descriptions', () => {
  // Both [+4, -4] and [-4, +4] satisfy a zero delta; the wording settles it.
  const { rows, parseErrors } = signByRunningBalance(
    [row('Monthly fee', 4), row('Monthly Fee Rebate', 4, 257.32)],
    257.32,
    257.32,
  );
  assert.deepEqual(amounts(rows), [-4, 4]);
  assert.deepEqual(parseErrors, []);
});

test('an offsetting pair the wording cannot separate is flagged as ambiguous', () => {
  const { rows, parseErrors } = signByRunningBalance(
    [row('Incoming payment', 100), row('Outgoing payment', 100, 500)],
    500,
    500,
  );
  assert.equal(rows.length, 2);
  assert.ok(parseErrors.some((e) => e.message.includes('ambiguous')), JSON.stringify(parseErrors));
});

test('trailing balance-less rows are solved against the closing balance', () => {
  const { rows, parseErrors } = signByRunningBalance(
    [row('Online Banking transfer', 20, 80), row('Monthly fee', 4)],
    100,
    76,
  );
  assert.deepEqual(amounts(rows), [-20, -4]);
  assert.deepEqual(parseErrors, []);
});

test('trailing balance-less rows with no closing balance default to credit and are flagged', () => {
  const { rows, parseErrors } = signByRunningBalance([row('Misc payment', 10)], 100, null);
  assert.deepEqual(amounts(rows), [10]);
  assert.ok(parseErrors.some((e) => e.message.includes('defaulting to credit')));
});

test('a run no sign combination satisfies is flagged and does not throw', () => {
  const { rows, parseErrors } = signByRunningBalance(
    [row('Transfer', 10), row('Fee', 3, 50)],
    100,
    50,
  );
  assert.equal(rows.length, 2);
  assert.ok(parseErrors.some((e) => e.message.includes('Could not determine sign')));
});
