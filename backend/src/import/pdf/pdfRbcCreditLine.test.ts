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
import type { PdfLine, PdfTextSpan } from './types.js';
import {
  rbcCreditLineParser,
  parseRbcCreditLineActivity,
} from './rbcCreditLine.js';

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
  // The gate's verdict must carry `blocking: true` — that flag, not the message
  // text, is what makes commitStatementImport refuse the import. This is the
  // gate that caught the +6,400 payment booked as a -6,400 withdrawal and was
  // then ignored by the commit path.
  assert.ok(
    reconErrors.every(e => e.blocking === true),
    `Reconciliation errors must be blocking, got: ${JSON.stringify(reconErrors)}`,
  );
});

test('an ordinary row-level parse error is NOT blocking', () => {
  // A clean statement's non-reconciliation errors (e.g. a "gate skipped"
  // notice, an unreadable row) must never stop an import — only the
  // arithmetic verdict does.
  const result = rbcCreditLineParser.parse(CLEAN_RECONCILE_LINES, { defaultCurrency: 'CAD' });
  assert.equal(
    result.parseErrors.filter((e) => e.blocking === true).length,
    0,
    `A reconciling statement must produce no blocking errors, got: ${JSON.stringify(result.parseErrors)}`,
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

// ─── opening principal extraction ─────────────────────────────────────────────
//
// Signing is delta-based from the opening principal, so a missing/unparseable
// opening must be a hard parse error: defaulting to 0 flips the sign of leading
// payment rows exactly when the reconciliation gate (which needs the same
// summary lines) is also skipped. A "Principal balance on July 8, 2025" line
// whose dollar figure wrapped to the next line must NOT parse the year 2025 as
// a $2,025.00 balance.

const WRAPPED_OPENING_LINES: PdfLine[] = [
  mkHeader('ROYAL BANK OF CANADA', 1, 730),
  mkHeader(' Your Royal Credit Line', 1, 719),
  mkHeader(' Statement', 1, 691),
  mkHeader('From July 8, 2025 to August 4, 2025', 1, 671),
  mkHeader(' Your loan account number:   73772650-001', 1, 627),
  // Dollar figure wrapped to the next line — no money token on this line.
  mkHeader('Principal balance on July 8, 2025', 1, 424),
  mkHeader(' Details of your account activity', 1, 185),
  mkLine(' 9 Jul   WWW TFR TIN0-02268   4,000.00   -4,000.00', 1, 151, 47.3),
  mkHeader(' Your LoanProtector insurance coverage summary', 1, 100),
];

const NO_SUMMARY_LINES: PdfLine[] = [
  mkHeader('ROYAL BANK OF CANADA', 1, 730),
  mkHeader(' Your Royal Credit Line', 1, 719),
  mkHeader(' Statement', 1, 691),
  mkHeader('From July 8, 2025 to August 4, 2025', 1, 671),
  mkHeader(' Your loan account number:   73772650-001', 1, 627),
  mkHeader(' Details of your account activity', 1, 185),
  mkLine(' 9 Jul   WWW TFR TIN0-02268   4,000.00   -4,000.00', 1, 151, 47.3),
  mkHeader(' Your LoanProtector insurance coverage summary', 1, 100),
];

test('parse throws when the opening principal line has no dollar figure (wrapped amount, not year-as-balance)', () => {
  assert.throws(
    () => rbcCreditLineParser.parse(WRAPPED_OPENING_LINES, { defaultCurrency: 'CAD' }),
    /opening principal/i,
  );
});

test('parse throws when the opening principal summary line is missing entirely', () => {
  assert.throws(
    () => rbcCreditLineParser.parse(NO_SUMMARY_LINES, { defaultCurrency: 'CAD' }),
    /opening principal/i,
  );
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

// ─── Interest rows are not transactions on the credit line ───────────────────
//
// Interest on a Royal Credit Line is billed to the linked RBC chequing account,
// not capitalised into the principal — the statement proves it by leaving the
// balance-owing column unchanged across the interest row. The chequing
// statement records the same event as "Loan interest", so emitting it here too
// books the cost twice (once as a fee on chequing, once as a purchase on the
// line) and overstates the amount owing by the cumulative interest.
//
// In prod all 7 credit-line interest rows matched a chequing "LOAN INTEREST"
// row exactly on date and amount, and the line reported 516.63 more owing than
// the statement.
//
// The parser already distinguishes them (`isPrincipalChange: false`) and
// already excludes them from its reconciliation sum; it just emitted them
// anyway.

test('interest rows are excluded from the emitted transactions', () => {
  const result = rbcCreditLineParser.parse(MULTI_TXN_LINES, { defaultCurrency: 'CAD' });

  assert.equal(result.transactions.length, 3);
  assert.deepEqual(
    result.transactions.map((t) => t.amount),
    [-400, -1150, -2000],
  );
  assert.ok(
    !result.transactions.some((t) => /interest/i.test(t.merchantRaw)),
    `interest row leaked into transactions: ${JSON.stringify(result.transactions.map((t) => t.merchantRaw))}`,
  );
});

test('excluding interest keeps the principal reconciliation intact', () => {
  // Opening 4,000 + (-400 -1,150 -2,000) = -7,550 owing, matching the
  // statement's closing principal. Interest never entered that sum.
  const result = rbcCreditLineParser.parse(MULTI_TXN_LINES, { defaultCurrency: 'CAD' });
  const recon = result.parseErrors.filter((e) => e.message.includes('does not reconcile'));
  assert.deepEqual(recon, []);
  const sum = result.transactions.reduce((acc, t) => acc + t.amount, 0);
  assert.equal(-4000 + sum, -7550);
});

test('the row-level parser still reports interest rows, flagged as non-principal', () => {
  // The information is not lost — only its promotion to a transaction is. The
  // reconciliation gate depends on still seeing these rows.
  const { rows } = parseRbcCreditLineActivity(MULTI_TXN_LINES, { start: '2025-08-05', end: '2025-09-03' }, 4000);
  const interest = rows.filter((r) => !r.isPrincipalChange);
  assert.equal(interest.length, 1);
  assert.match(interest[0].description, /Interest Payment/i);
});

// ─── No-balance rows: fall back to the description, not a blind "withdrawal" ──
//
// When the balance-owing column can't be read for a row and the two-row
// lookahead can't disambiguate it either, the parser used to guess
// "withdrawal" AND mark the row a principal change, ignoring the description.
// Both guesses are wrong on real statements:
//
//   Credit Line Statement-0001 2026-03-03.pdf — a *payment* of 6,400 that
//   cleared the line to zero was booked as a 6,400 withdrawal: a 12,800 error
//   on the account balance, and the statement stopped reconciling.
//
//   Credit Line Statement-0001 2026-04-06.pdf — an `Interest Payment` row was
//   marked a principal change, leaking into the emitted transactions (interest
//   is billed to the linked chequing account and is already recorded there)
//   and pushing the reconciled closing principal 17.24 past the statement's.
//
// The description is unambiguous on these statements, so it is the fallback.

// Real case 1: period 2026-02-04..2026-03-03, opening 6,400, closing 0.
// The payment row's balance column is unreadable and there is no later row to
// look ahead to, so sign resolution falls through to the description.
const NO_BALANCE_PAYMENT_LINES: PdfLine[] = [
  mkHeader('ROYAL BANK OF CANADA', 1, 730),
  mkHeader(' Your Royal Credit Line', 1, 719),
  mkHeader(' Statement', 1, 691),
  mkHeader('From February 4, 2026 to March 3, 2026', 1, 671),
  mkHeader(' Your loan account number:   73772650-001', 1, 627),
  mkHeader('Principal balance on February 4, 2026   $6,400.00', 1, 424),
  mkHeader('Principal balance on March 3, 2026   $0.00', 1, 342),
  mkHeader(' Details of your account activity', 1, 185),
  mkLine(' Date   Description   Interest/Fees/Insurance ($)   Withdrawals ($)   Payments ($)   Balance owing ($)', 1, 167, 45.1),
  mkLine(' 16 Feb   WWW PMT TIN0-04766 (6,400.00)', 1, 151, 47.3),
  mkLine('Principal   6,400.00', 1, 138, 63.4),
  mkHeader(' Your LoanProtector insurance coverage summary', 1, 100),
];

test('no-balance "WWW PMT … Principal" row is a payment (positive), not a withdrawal', () => {
  const period = { start: '2026-02-04', end: '2026-03-03' };
  const { rows, parseErrors } = parseRbcCreditLineActivity(NO_BALANCE_PAYMENT_LINES, period, 6400);

  assert.equal(rows.length, 1, `Expected 1 row, got ${JSON.stringify(rows)}`);
  assert.equal(rows[0].date, '2026-02-16');
  assert.equal(rows[0].amount, 6400, 'payment must be positive cashflow');
  assert.equal(rows[0].isPrincipalChange, true);
  assert.deepEqual(parseErrors, [], 'description resolves the sign — no parse error');
});

test('the 6,400 payment statement reconciles to a zero closing principal', () => {
  const result = rbcCreditLineParser.parse(NO_BALANCE_PAYMENT_LINES, { defaultCurrency: 'CAD' });
  assert.deepEqual(result.parseErrors, [], `expected a clean parse: ${JSON.stringify(result.parseErrors)}`);
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].amount, 6400);
});

// Real case 2: period 2026-03-04..2026-04-06, opening 0, closing 7,000.
// The interest row has no balance column; the next row does, so the two-row
// lookahead runs and fails (no signed combination hits the delta) — because
// interest never moves the principal at all.
const NO_BALANCE_INTEREST_LINES: PdfLine[] = [
  mkHeader('ROYAL BANK OF CANADA', 1, 730),
  mkHeader(' Your Royal Credit Line', 1, 719),
  mkHeader(' Statement', 1, 691),
  mkHeader('From March 4, 2026 to April 6, 2026', 1, 671),
  mkHeader(' Your loan account number:   73772650-001', 1, 627),
  mkHeader('Principal balance on March 4, 2026   $0.00', 1, 424),
  mkHeader('Principal balance on April 6, 2026   $7,000.00', 1, 342),
  mkHeader(' Details of your account activity', 1, 185),
  mkLine(' Date   Description   Interest/Fees/Insurance ($)   Withdrawals ($)   Payments ($)   Balance owing ($)', 1, 167, 45.1),
  mkLine(' 5 Mar   Interest Payment   17.24', 1, 151, 47.3),
  mkLine('17 Mar   WWW TFR TIN0-06604   6,000.00   -6,000.00', 1, 136, 45.1),
  mkLine('18 Mar   WWW TFR TIN0-03079   1,000.00   -7,000.00', 1, 120, 45.1),
  mkHeader(' Your LoanProtector insurance coverage summary', 1, 100),
];

test('no-balance "Interest Payment" row is interest, not a principal change', () => {
  const period = { start: '2026-03-04', end: '2026-04-06' };
  const { rows, parseErrors } = parseRbcCreditLineActivity(NO_BALANCE_INTEREST_LINES, period, 0);

  assert.equal(rows.length, 3, `Expected 3 rows, got ${JSON.stringify(rows)}`);
  assert.equal(rows[0].date, '2026-03-05');
  assert.equal(rows[0].amount, -17.24, 'interest is a cost → negative cashflow');
  assert.equal(rows[0].isPrincipalChange, false, 'interest must NOT move principal');
  // The interest row must not consume balance headroom: the following
  // withdrawals still resolve off their own balance column.
  assert.equal(rows[1].amount, -6000);
  assert.equal(rows[2].amount, -1000);
  assert.deepEqual(parseErrors, [], 'description resolves the sign — no parse error');
});

test('the interest statement reconciles and does not emit the interest row', () => {
  const result = rbcCreditLineParser.parse(NO_BALANCE_INTEREST_LINES, { defaultCurrency: 'CAD' });
  assert.deepEqual(result.parseErrors, [], `expected a clean parse: ${JSON.stringify(result.parseErrors)}`);
  assert.deepEqual(result.transactions.map((t) => t.amount), [-6000, -1000]);
  assert.ok(!result.transactions.some((t) => /interest/i.test(t.merchantRaw)));
});

test('no-balance "WWW TFR" row is still a withdrawal', () => {
  const lines: PdfLine[] = [
    mkHeader('ROYAL BANK OF CANADA', 1, 730),
    mkHeader(' Your Royal Credit Line', 1, 719),
    mkHeader(' Statement', 1, 691),
    mkHeader('From March 4, 2026 to April 6, 2026', 1, 671),
    mkHeader(' Your loan account number:   73772650-001', 1, 627),
    mkHeader('Principal balance on March 4, 2026   $0.00', 1, 424),
    mkHeader('Principal balance on April 6, 2026   $2,500.00', 1, 342),
    mkHeader(' Details of your account activity', 1, 185),
    mkLine(' 9 Mar   WWW TFR TIN0-11111   2,500.00', 1, 151, 47.3),
    mkHeader(' Your LoanProtector insurance coverage summary', 1, 100),
  ];
  const result = rbcCreditLineParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.deepEqual(result.parseErrors, []);
  assert.deepEqual(result.transactions.map((t) => t.amount), [-2500]);
});

test('an unrecognised no-balance description still defaults to withdrawal AND records a parseError', () => {
  const lines: PdfLine[] = [
    mkHeader('ROYAL BANK OF CANADA', 1, 730),
    mkHeader(' Your Royal Credit Line', 1, 719),
    mkHeader(' Statement', 1, 691),
    mkHeader('From March 4, 2026 to April 6, 2026', 1, 671),
    mkHeader(' Your loan account number:   73772650-001', 1, 627),
    mkHeader('Principal balance on March 4, 2026   $0.00', 1, 424),
    mkHeader('Principal balance on April 6, 2026   $2,500.00', 1, 342),
    mkHeader(' Details of your account activity', 1, 185),
    mkLine(' 9 Mar   ZZZ MYSTERY ROW   2,500.00', 1, 151, 47.3),
    mkHeader(' Your LoanProtector insurance coverage summary', 1, 100),
  ];
  const { rows, parseErrors } = parseRbcCreditLineActivity(
    lines,
    { start: '2026-03-04', end: '2026-04-06' },
    0,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, -2500);
  assert.equal(rows[0].isPrincipalChange, true);
  assert.equal(parseErrors.length, 1, `expected a parseError: ${JSON.stringify(parseErrors)}`);
  assert.match(parseErrors[0].message, /ZZZ MYSTERY ROW/);
});
