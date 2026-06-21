import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PdfLine } from './types';
import { parseRbcVisaActivity, rbcVisaParser } from './rbcVisa';

function mk(text: string, page = 1, y = 0): PdfLine {
  return { page, y, text };
}

const PERIOD = { start: '2025-11-08', end: '2025-12-08' };

test('parseRbcVisaActivity takes the LAST money token as the amount (a $ figure in the description does not steal it)', () => {
  // The description carries a "$5.00 CREDIT" promo blurb before the real amount
  // column. The amount column is the LAST money token on the row ($42.99).
  const lines: PdfLine[] = [
    mk('ACTIVITY DESCRIPTION'),
    mk('NOV 12  NOV 14  AMAZON $5.00 CREDIT PURCHASE  $42.99'),
    mk('TOTAL ACCOUNT BALANCE'),
  ];
  const { rows, parseErrors } = parseRbcVisaActivity(lines, PERIOD);
  assert.equal(parseErrors.length, 0, JSON.stringify(parseErrors));
  assert.equal(rows.length, 1);
  // Sign flip: PDF positive charge → cashflow negative.
  assert.equal(rows[0].amount, -42.99);
  assert.ok(rows[0].description.includes('AMAZON'), rows[0].description);
});

test('parseRbcVisaActivity keeps the single-token amount when the description has no $ figure', () => {
  const lines: PdfLine[] = [
    mk('ACTIVITY DESCRIPTION'),
    mk('DEC 01  DEC 01  ANNUAL FEE  $39.00'),
    mk('TOTAL ACCOUNT BALANCE'),
  ];
  const { rows } = parseRbcVisaActivity(lines, PERIOD);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, -39.0);
});

test('rbcVisaParser surfaces a reconciliation warning when parsed charges disagree with the printed purchases total', () => {
  const lines: PdfLine[] = [
    mk('Signature® RBC Rewards® Visa‡'),
    mk('CONNOR ADAMS 4510 15** **** 5234'),
    mk('STATEMENT FROM NOV 08 TO DEC 8, 2025'),
    mk('ACTIVITY DESCRIPTION'),
    mk('NOV 12  NOV 14  SPOTIFY  $14.34'),
    mk('NOV 20  NOV 22  GROCERY  $20.00'),
    // Printed purchases total disagrees (real sum is 34.34).
    mk('Total purchases, cash advances & interest  $99.99'),
    mk('TOTAL ACCOUNT BALANCE'),
  ];
  const res = rbcVisaParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(res.transactions.length, 2);
  assert.equal(res.warnings.length, 1, JSON.stringify(res.warnings));
  assert.ok(/mismatch/i.test(res.warnings[0]), res.warnings[0]);
  // The printed total line must not leak into the last transaction description.
  assert.ok(
    !res.transactions[1].merchantRaw.toLowerCase().includes('total purchases'),
    res.transactions[1].merchantRaw,
  );
});

test('rbcVisaParser does not warn when parsed charges match the printed purchases total', () => {
  const lines: PdfLine[] = [
    mk('Signature® RBC Rewards® Visa‡'),
    mk('CONNOR ADAMS 4510 15** **** 5234'),
    mk('STATEMENT FROM NOV 08 TO DEC 8, 2025'),
    mk('ACTIVITY DESCRIPTION'),
    mk('NOV 12  NOV 14  SPOTIFY  $14.34'),
    mk('NOV 20  NOV 22  GROCERY  $20.00'),
    mk('Total purchases, cash advances & interest  $34.34'),
    mk('TOTAL ACCOUNT BALANCE'),
  ];
  const res = rbcVisaParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.deepEqual(res.warnings, []);
});

test('rbcVisaParser does not warn (soft) when no printed total is present', () => {
  const lines: PdfLine[] = [
    mk('Signature® RBC Rewards® Visa‡'),
    mk('CONNOR ADAMS 4510 15** **** 5234'),
    mk('STATEMENT FROM NOV 08 TO DEC 8, 2025'),
    mk('ACTIVITY DESCRIPTION'),
    mk('NOV 12  NOV 14  SPOTIFY  $14.34'),
    mk('TOTAL ACCOUNT BALANCE'),
  ];
  const res = rbcVisaParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.deepEqual(res.warnings, []);
});
