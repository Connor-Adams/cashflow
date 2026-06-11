/**
 * RBC Visa activity parsing + statement reconciliation gate.
 *
 * Synthetic PdfLine fixtures (no PDF fixtures needed), mirroring the
 * pdfRbcPersonalBanking.test.ts pattern.
 *
 * Covers two audit findings:
 *  - Amount extraction must take the TRAILING $-token on a date-prefixed row
 *    (the AMOUNT ($) column is rightmost). Taking the first $-token lets a
 *    dollar figure inside a merchant descriptor steal the amount.
 *  - The parser must reconcile previous balance + Σ activity against the
 *    printed TOTAL ACCOUNT BALANCE so silently swallowed/corrupted rows
 *    surface as a parseError instead of importing wrong data with no signal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PdfLine } from './types';
import { parseRbcVisaActivity, rbcVisaParser } from './rbcVisa';

function mk(text: string, page = 1): PdfLine {
  return { page, y: 0, text };
}

const PERIOD = { start: '2025-11-08', end: '2025-12-08' };

function activityLines(rows: string[]): PdfLine[] {
  return [
    mk('TRANSACTION DATE POSTING DATE ACTIVITY DESCRIPTION AMOUNT ($)'),
    ...rows.map((r) => mk(r)),
    mk('TOTAL ACCOUNT BALANCE $0.00'),
  ];
}

// ─── Amount extraction (trailing $-token) ──────────────────────────────────

test('amount is the TRAILING $-token; a $-figure inside the description must not steal it', () => {
  const { rows, parseErrors } = parseRbcVisaActivity(
    activityLines(['DEC 01 DEC 01 SP * $9.99 SOCKS TORONTO $45.20']),
    PERIOD,
  );
  assert.deepEqual(parseErrors, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, -45.2);
  assert.equal(rows[0].description, 'SP * $9.99 SOCKS TORONTO');
});

test('payment row with negative trailing amount flips to positive cashflow', () => {
  const { rows } = parseRbcVisaActivity(
    activityLines(['DEC 05 DEC 05 PAYMENT - THANK YOU -$500.00']),
    PERIOD,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 500);
  assert.equal(rows[0].description, 'PAYMENT - THANK YOU');
});

test('amount on its own continuation line, reference number excluded from description', () => {
  const { rows } = parseRbcVisaActivity(
    activityLines([
      'NOV 07 NOV 10 SPOTIFY P3C3196378 STOCKHOLM',
      '74987505311002642493068',
      '$14.34',
    ]),
    PERIOD,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, -14.34);
  assert.equal(rows[0].description, 'SPOTIFY P3C3196378 STOCKHOLM');
});

test('a stray standalone amount line must NOT overwrite an already-set amount', () => {
  const { rows } = parseRbcVisaActivity(
    activityLines(['NOV 10 NOV 12 STARBUCKS TORONTO $25.00', '$99.00']),
    PERIOD,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, -25, 'amount from the date line must win over a stray later line');
});

// ─── Statement reconciliation gate ─────────────────────────────────────────

function statementLines(opts: {
  previous?: string;
  rows: string[];
  total: string;
}): PdfLine[] {
  return [
    mk('Signature RBC Rewards Visa'),
    mk('CONNOR ADAMS 4510 15** **** 5234'),
    mk('STATEMENT FROM NOV 08 TO DEC 8, 2025'),
    ...(opts.previous ? [mk(`PREVIOUS STATEMENT BALANCE ${opts.previous}`)] : []),
    mk('TRANSACTION DATE POSTING DATE ACTIVITY DESCRIPTION AMOUNT ($)', 2),
    ...opts.rows.map((r) => mk(r, 2)),
    mk(`TOTAL ACCOUNT BALANCE ${opts.total}`, 2),
  ];
}

test('reconciliation gate fires a parseError when parsed activity contradicts printed totals', () => {
  const out = rbcVisaParser.parse(
    statementLines({
      previous: '$100.00',
      rows: [
        'NOV 10 NOV 12 STARBUCKS TORONTO $25.00',
        'NOV 15 NOV 16 TIM HORTONS TORONTO $10.00',
      ],
      total: '$200.00', // printed total disagrees: 100 + 35 = 135 ≠ 200
    }),
    { defaultCurrency: 'CAD' },
  );
  assert.equal(out.transactions.length, 2);
  assert.ok(
    out.parseErrors.some((e) => e.message.includes('does not reconcile')),
    `expected a reconciliation parseError, got: ${JSON.stringify(out.parseErrors)}`,
  );
});

test('clean statement reconciles: no parseErrors, no reconciliation warning', () => {
  const out = rbcVisaParser.parse(
    statementLines({
      previous: '$100.00',
      rows: [
        'NOV 10 NOV 12 STARBUCKS TORONTO $25.00',
        'NOV 20 NOV 21 PAYMENT - THANK YOU -$135.00',
      ],
      total: '-$10.00', // 100 + 25 - 135 = -10
    }),
    { defaultCurrency: 'CAD' },
  );
  assert.deepEqual(out.parseErrors, []);
  assert.deepEqual(out.warnings, []);
  assert.equal(out.transactions.length, 2);
});

test('statement without extractable totals: gate skipped with a warning, no false error', () => {
  const out = rbcVisaParser.parse(
    statementLines({
      rows: ['NOV 10 NOV 12 STARBUCKS TORONTO $25.00'],
      total: '$25.00',
    }),
    { defaultCurrency: 'CAD' },
  );
  assert.deepEqual(out.parseErrors, []);
  assert.ok(
    out.warnings.some((w) => w.includes('gate skipped')),
    `expected a gate-skipped warning, got: ${JSON.stringify(out.warnings)}`,
  );
});
