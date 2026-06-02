/**
 * Unit tests for the RBC Royal Credit Line PDF parser.
 *
 * Fixture layout mirrors real monthly statements (Aug-Dec 2025):
 *   - Period: "From July 8, 2025 to August 4, 2025"
 *   - Section: "Details of your account activity"
 *   - Columns: Date | Description | Interest/Fees/Insurance ($) | Withdrawals ($) | Payments ($) | Balance owing ($)
 *   - items=1 per row (pdfjs v5 glues the entire row into one text item)
 *   - Dated rows x≈47.3: "D Mon   Description   amount   signed_balance"
 *   - Dateless continuation rows x≈63.4: "Description   amount   signed_balance"
 *   - Balance column is SIGNED: negative = amount owed (e.g. -4,000.00)
 *   - Withdrawals INCREASE the debt (balance more negative) → cashflow negative
 *   - Payments DECREASE the debt (balance less negative) → cashflow positive
 *   - Interest/fees DO NOT change the principal balance (processed separately) → cashflow negative
 *   - Opening balance: from summary "Principal balance on [period-start]   $X.XX"
 *   - Closing balance: from summary "Principal balance on [period-end]   $X.XX"
 *   - Section ends at "Your LoanProtector insurance coverage summary" or "Rate History"
 *
 * All tests RED against current item-position-based parser, GREEN after fix.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PdfLine, PdfTextSpan } from '../src/import/pdf/types.js';
import {
  rbcCreditLineParser,
  parseRbcCreditLineActivity,
} from '../src/import/pdf/rbcCreditLine.js';

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function mkLine(text: string, page = 1, y = 0, x = 47.3): PdfLine {
  const span: PdfTextSpan = { x, width: text.length * 5, str: text.trim() };
  return { page, y, text, items: [span] };
}

function mkHeader(text: string, page = 1, y = 0): PdfLine {
  return { page, y, text };
}

// ─── Synthetic fixture: multi-txn with withdrawals + payment + interest ────────
//
// Mirrors Credit Line Statement-0001 2025-09-03.pdf (Aug 5 to Sep 3):
//   Opening principal (Aug 5): $4,000.00  → displayed as -4,000.00 in balance column
//   5 Aug   Interest Payment   41.38   -4,000.00   (interest; balance unchanged)
//   11 Aug   WWW TFR TIN0-09339   400.00   -4,400.00   (withdrawal; balance -4000→-4400)
//   14 Aug   WWW TFR TIN0-06177   1,150.00   -5,550.00  (withdrawal)
//   21 Aug   WWW TFR TIN0-08886   2,000.00   -7,550.00  (withdrawal)
//   Closing principal (Sep 3): $7,550.00  → -7,550.00

const MULTI_TXN_LINES: PdfLine[] = [
  mkHeader('ROYAL BANK OF CANADA', 1, 730),
  mkHeader(' Your Royal Credit Line', 1, 719),
  mkHeader(' Statement', 1, 691),
  mkHeader('From August 5, 2025 to September 3, 2025', 1, 671),
  mkHeader(' Your loan account number:   73772650-001', 1, 627),
  // Opening/closing balance from summary section
  mkHeader('Principal balance on August 5, 2025   $4,000.00', 1, 424),
  mkHeader('Principal balance on September 3, 2025   $7,550.00', 1, 342),
  mkHeader(' Details of your account activity', 1, 185),
  mkLine(' Date   Description   Interest/Fees/Insurance ($)   Withdrawals ($)   Payments ($)   Balance owing ($)', 1, 167, 45.1),
  // Interest row: balance stays the same (interest processed to payment account)
  mkLine(' 5 Aug   Interest Payment   41.38   -4,000.00', 1, 151, 47.3),
  // Withdrawals (each increases debt)
  mkLine('11 Aug   WWW TFR TIN0-09339   400.00   -4,400.00', 1, 136, 45.1),
  mkLine('14 Aug   WWW TFR TIN0-06177   1,150.00   -5,550.00', 1, 120, 45.1),
  mkHeader(' Details of your account activity   -   continued', 2, 658),
  mkLine(' Date   Description   Interest/Fees/Insurance ($)   Withdrawals ($)   Payments ($)   Balance owing ($)', 2, 640, 23.8),
  mkLine(' 21 Aug   WWW TFR TIN0-08886   2,000.00   -7,550.00', 2, 625, 23.8),
  mkHeader(' Your LoanProtector insurance coverage summary', 2, 548),
];

// ─── Synthetic fixture: glued single-item row (regression) ────────────────────
//
// The bug: items=1 per row, so the old moneySpans() returns 0 money spans.
// The fixed parser must split on 2+ spaces.
const GLUED_ROW_LINES: PdfLine[] = [
  mkHeader('ROYAL BANK OF CANADA', 1, 730),
  mkHeader(' Your Royal Credit Line', 1, 719),
  mkHeader(' Statement', 1, 691),
  mkHeader('From July 8, 2025 to August 4, 2025', 1, 671),
  mkHeader(' Your loan account number:   73772650-001', 1, 627),
  mkHeader('Principal balance on July 8, 2025   $0.00', 1, 424),
  mkHeader('Principal balance on August 4, 2025   $4,000.00', 1, 342),
  mkHeader(' Details of your account activity', 1, 185),
  mkLine(' Date   Description   Interest/Fees/Insurance ($)   Withdrawals ($)   Payments ($)   Balance owing ($)', 1, 167, 45.1),
  // Single glued item — withdrawal increases debt 0→-4000
  mkLine(' 9 Jul   WWW TFR TIN0-02268   4,000.00   -4,000.00', 1, 151, 47.3),
  mkHeader(' Your LoanProtector insurance coverage summary', 1, 548),
];

// ─── Synthetic fixture: payment + withdrawal (mixed directions) ────────────────
//
// Mirrors Credit Line Statement-0001 2025-08-04.pdf (Jul 8 to Aug 4):
//   Opening principal: $0.00
//   9 Jul   WWW TFR TIN0-02268   5,000.00   -5,000.00  (withdrawal)
//   9 Jul   WWW TFR TIN0-08997   1,000.00   -6,000.00  (withdrawal)
//   10 Jul   WWW TFR TIN0-04989   3,000.00   -9,000.00  (withdrawal)
//   16 Jul   WWW PMT TIN0-05444 (1,000.00)             (desc only, no amounts)
//             Principal   1,000.00   -8,000.00          (dateless: payment amount+balance)
//   21 Jul   WWW PMT TIN0-08274 (4,000.00)
//             Principal   4,000.00   -4,000.00          (payment)
//   Closing: $4,000.00

const PAYMENT_LINES: PdfLine[] = [
  mkHeader('ROYAL BANK OF CANADA', 1, 730),
  mkHeader(' Your Royal Credit Line', 1, 719),
  mkHeader(' Statement', 1, 691),
  mkHeader('From July 8, 2025 to August 4, 2025', 1, 671),
  mkHeader(' Your loan account number:   73772650-001', 1, 627),
  mkHeader('Principal balance on July 8, 2025   $0.00', 1, 424),
  mkHeader('Principal balance on August 4, 2025   $4,000.00', 1, 342),
  mkHeader(' Details of your account activity', 1, 185),
  mkLine(' Date   Description   Interest/Fees/Insurance ($)   Withdrawals ($)   Payments ($)   Balance owing ($)', 1, 167, 45.1),
  mkLine(' 9 Jul   WWW TFR TIN0-02268   5,000.00   -5,000.00', 1, 151, 47.3),
  mkLine('9 Jul   WWW TFR TIN0-08997   1,000.00   -6,000.00', 1, 136, 45.1),
  mkLine('10 Jul   WWW TFR TIN0-04989   3,000.00   -9,000.00', 1, 120, 45.1),
  mkHeader(' Details of your account activity   -   continued', 2, 658),
  mkLine(' Date   Description   Interest/Fees/Insurance ($)   Withdrawals ($)   Payments ($)   Balance owing ($)', 2, 640, 23.8),
  // Payment row split across two lines: description only first, then dateless with amount+balance
  mkLine(' 16 Jul   WWW PMT TIN0-05444 (1,000.00)', 2, 625, 23.8),
  mkLine('Principal   1,000.00   -8,000.00', 2, 612, 63.4),
  mkLine('21 Jul   WWW PMT TIN0-08274 (4,000.00)', 2, 596, 23.8),
  mkLine('Principal   4,000.00   -4,000.00', 2, 583, 63.4),
  mkHeader(' Your LoanProtector insurance coverage summary', 2, 548),
];

// ─── Synthetic fixture: reconciliation mismatch ───────────────────────────────
//
// Opening: $1,000.00 owed → balance col -1,000.00
// Withdrawal: 500.00 → balance -1,500.00
// Closing: $1,500.00 → reconciles (opening 1000 + withdrawal 500 = 1500)
// But we lie: closing = 2,000.00 → mismatch

const RECON_MISMATCH_LINES: PdfLine[] = [
  mkHeader('ROYAL BANK OF CANADA', 1, 730),
  mkHeader(' Your Royal Credit Line', 1, 719),
  mkHeader(' Statement', 1, 691),
  mkHeader('From November 4, 2025 to December 3, 2025', 1, 671),
  mkHeader(' Your loan account number:   73772650-001', 1, 627),
  mkHeader('Principal balance on November 4, 2025   $1,000.00', 1, 424),
  // Lie: closing says 2,000 but transactions only get to 1,500
  mkHeader('Principal balance on December 3, 2025   $2,000.00', 1, 342),
  mkHeader(' Details of your account activity', 1, 185),
  mkLine(' Date   Description   Interest/Fees/Insurance ($)   Withdrawals ($)   Payments ($)   Balance owing ($)', 1, 167, 45.1),
  mkLine(' 10 Nov   WWW TFR   500.00   -1,500.00', 1, 151, 47.3),
  mkHeader(' Your LoanProtector insurance coverage summary', 1, 100),
];

// ─── Synthetic fixture: clean statement that reconciles ────────────────────────

const CLEAN_RECONCILE_LINES: PdfLine[] = [
  mkHeader('ROYAL BANK OF CANADA', 1, 730),
  mkHeader(' Your Royal Credit Line', 1, 719),
  mkHeader(' Statement', 1, 691),
  mkHeader('From November 4, 2025 to December 3, 2025', 1, 671),
  mkHeader(' Your loan account number:   73772650-001', 1, 627),
  mkHeader('Principal balance on November 4, 2025   $1,000.00', 1, 424),
  mkHeader('Principal balance on December 3, 2025   $1,500.00', 1, 342),
  mkHeader(' Details of your account activity', 1, 185),
  mkLine(' Date   Description   Interest/Fees/Insurance ($)   Withdrawals ($)   Payments ($)   Balance owing ($)', 1, 167, 45.1),
  mkLine(' 10 Nov   WWW TFR   500.00   -1,500.00', 1, 151, 47.3),
  mkHeader(' Your LoanProtector insurance coverage summary', 1, 100),
];

// ─── sniff() tests ────────────────────────────────────────────────────────────

test('rbcCreditLineParser sniff matches Royal Credit Line title', () => {
  assert.equal(
    rbcCreditLineParser.sniff([
      { page: 1, y: 0, text: 'Your Royal Credit Line® Statement' },
    ]),
    true,
  );
});

// ─── REGRESSION: glued row parses to non-zero txn ────────────────────────────

test('REGRESSION: single glued-item row parses to non-zero txn', () => {
  const period = { start: '2025-07-08', end: '2025-08-04' };
  const { rows, parseErrors } = parseRbcCreditLineActivity(GLUED_ROW_LINES, period, 0);
  assert.equal(
    rows.length,
    1,
    `Expected 1 row (not 0), got ${rows.length}. parseErrors: ${JSON.stringify(parseErrors)}`,
  );
  assert.equal(rows[0].date, '2025-07-09');
  // Withdrawal: debt increases 0→4000 → cashflow negative
  assert.equal(rows[0].amount, -4000);
});

// ─── multi-txn: interest + withdrawals ───────────────────────────────────────

test('parseRbcCreditLineActivity: interest payment does not change balance, withdrawals are negative', () => {
  const period = { start: '2025-08-05', end: '2025-09-03' };
  const { rows, parseErrors } = parseRbcCreditLineActivity(MULTI_TXN_LINES, period, 4000);

  // Expected: 4 rows (interest + 3 withdrawals)
  assert.equal(rows.length, 4, `Expected 4 rows, got ${rows.length}: ${JSON.stringify(rows)}`);

  // Row 0: Interest Payment — negative, balance unchanged (-4000→-4000)
  assert.equal(rows[0].date, '2025-08-05');
  assert.ok(rows[0].description.toLowerCase().includes('interest'));
  assert.equal(rows[0].amount, -41.38);

  // Row 1: withdrawal -400
  assert.equal(rows[1].date, '2025-08-11');
  assert.equal(rows[1].amount, -400);

  // Row 2: withdrawal -1150
  assert.equal(rows[2].date, '2025-08-14');
  assert.equal(rows[2].amount, -1150);

  // Row 3: withdrawal -2000
  assert.equal(rows[3].date, '2025-08-21');
  assert.equal(rows[3].amount, -2000);

  const signErrors = parseErrors.filter(e => e.message.includes('defaulting'));
  assert.equal(signErrors.length, 0, `Unexpected sign-resolution errors: ${JSON.stringify(signErrors)}`);
});

// ─── multi-txn: withdrawals + payments ───────────────────────────────────────

test('parseRbcCreditLineActivity: withdrawals negative, payments positive, multi-line rows', () => {
  const period = { start: '2025-07-08', end: '2025-08-04' };
  const { rows, parseErrors } = parseRbcCreditLineActivity(PAYMENT_LINES, period, 0);

  // Expected: 5 rows
  // 9 Jul withdrawal -5000
  // 9 Jul withdrawal -1000
  // 10 Jul withdrawal -3000
  // 16 Jul payment +1000
  // 21 Jul payment +4000
  assert.equal(rows.length, 5, `Expected 5 rows, got ${rows.length}: ${JSON.stringify(rows)}`);

  assert.equal(rows[0].date, '2025-07-09');
  assert.equal(rows[0].amount, -5000);

  assert.equal(rows[1].date, '2025-07-09');
  assert.equal(rows[1].amount, -1000);

  assert.equal(rows[2].date, '2025-07-10');
  assert.equal(rows[2].amount, -3000);

  // Payments: balance less negative → positive cashflow
  assert.equal(rows[3].date, '2025-07-16');
  assert.ok(rows[3].amount > 0, `Expected positive payment, got ${rows[3].amount}`);
  assert.equal(rows[3].amount, 1000);

  assert.equal(rows[4].date, '2025-07-21');
  assert.equal(rows[4].amount, 4000);
});

// ─── reconciliation gate ──────────────────────────────────────────────────────

test('reconciliation gate fires when credit line statement does not reconcile', () => {
  const result = rbcCreditLineParser.parse(RECON_MISMATCH_LINES, { defaultCurrency: 'CAD' });
  const reconErrors = result.parseErrors.filter(e => e.message.includes('does not reconcile'));
  assert.ok(
    reconErrors.length > 0,
    `Expected a reconciliation parseError, got: ${JSON.stringify(result.parseErrors)}`,
  );
});

test('reconciliation gate passes cleanly for a correct credit line statement', () => {
  const result = rbcCreditLineParser.parse(CLEAN_RECONCILE_LINES, { defaultCurrency: 'CAD' });
  const reconErrors = result.parseErrors.filter(e => e.message.includes('does not reconcile'));
  assert.equal(
    reconErrors.length,
    0,
    `Expected no reconciliation errors, got: ${JSON.stringify(reconErrors)}`,
  );
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].amount, -500);
});

// ─── full parse integration ───────────────────────────────────────────────────

test('rbcCreditLineParser.parse: correct header + transactions for glued-row fixture', () => {
  const result = rbcCreditLineParser.parse(GLUED_ROW_LINES, { defaultCurrency: 'CAD' });
  assert.equal(result.transactions.length, 1, `Expected 1 txn, got ${result.transactions.length}`);
  assert.equal(result.transactions[0].amount, -4000);
  assert.equal(result.transactions[0].currency, 'CAD');
  assert.equal(result.header?.accountSuffix, '0001');
  assert.equal(result.header?.accountType, 'loan');
  assert.equal(result.header?.periodStart, '2025-07-08');
  assert.equal(result.header?.periodEnd, '2025-08-04');
});
