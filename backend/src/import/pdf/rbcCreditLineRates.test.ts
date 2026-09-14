import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRbcCreditLineRates } from './rbcCreditLine';
import type { PdfLine } from './types';

const line = (page: number, y: number, text: string): PdfLine => ({ page, y, text });

const HEADING = ' Rate History for your Statement Period';
const COLS = ' Rate from and including   Rate to and including   Prime Rate   Premium/discount   Your Rate   Applicable Interest ($)';

test('reads the single-rate case from a real statement row', () => {
  const rows = parseRbcCreditLineRates([
    line(2, 700, HEADING),
    line(2, 690, COLS),
    line(2, 680, 'August 4, 2026   September 3, 2026   4.450 %   +4.490 %   8.940 %   172.36'),
  ]);
  assert.deepEqual(rows, [{
    fromDate: '2026-08-04',
    toDate: '2026-09-03',
    primeRate: '4.4500',
    premium: '4.4900',
    effectiveRate: '8.9400',
    applicableInterest: '172.3600',
  }]);
});

test('reads several rate windows when prime moves mid-period', () => {
  const rows = parseRbcCreditLineRates([
    line(2, 700, HEADING),
    line(2, 690, COLS),
    line(2, 680, 'June 4, 2026   June 17, 2026   4.700 %   +4.490 %   9.190 %   60.10'),
    line(2, 670, 'June 18, 2026   July 3, 2026   4.450 %   +4.490 %   8.940 %   86.61'),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].effectiveRate, '9.1900');
  assert.equal(rows[1].fromDate, '2026-06-18');
  assert.equal(rows[1].applicableInterest, '86.6100');
});

test('handles a negative premium (a discount off prime)', () => {
  const rows = parseRbcCreditLineRates([
    line(2, 700, HEADING),
    line(2, 690, COLS),
    line(2, 680, 'May 5, 2026   June 3, 2026   4.450 %   -0.500 %   3.950 %   12.00'),
  ]);
  assert.equal(rows[0].premium, '-0.5000');
  assert.equal(rows[0].effectiveRate, '3.9500');
});

test('parses a thousands-separated interest figure', () => {
  const rows = parseRbcCreditLineRates([
    line(2, 700, HEADING),
    line(2, 690, COLS),
    line(2, 680, 'August 4, 2026   September 3, 2026   4.450 %   +4.490 %   8.940 %   1,172.36'),
  ]);
  assert.equal(rows[0].applicableInterest, '1172.3600');
});

test('stops at the next section rather than swallowing the page', () => {
  const rows = parseRbcCreditLineRates([
    line(2, 700, HEADING),
    line(2, 690, COLS),
    line(2, 680, 'August 4, 2026   September 3, 2026   4.450 %   +4.490 %   8.940 %   172.36'),
    line(2, 660, ' Important information about your account'),
    line(2, 650, 'Royal Credit Line account annual statements are now available through e-statements.'),
  ]);
  assert.equal(rows.length, 1);
});

test('the annual summary format yields no rows rather than throwing', () => {
  assert.deepEqual(parseRbcCreditLineRates([
    line(1, 700, 'Your Royal Credit Line Statement'),
    line(1, 690, 'Annual summary'),
  ]), []);
});

test('ignores the marketing copy glued onto the page-1 rate line', () => {
  // Page 1 renders "Prime Rate + 4.490 % = 8.940 %" with right-column text
  // appended. It is a cross-check, not a table row, and must not be parsed as one.
  assert.deepEqual(parseRbcCreditLineRates([
    line(1, 500, 'Prime Rate + 4.490 % = 8.940 %       1. Scroll down to Switch to RBC, click Get Started'),
    line(1, 490, 'Current interest rate'),
  ]), []);
});
