/**
 * Unit tests for the RBC Business Account Statement PDF parser.
 *
 * Uses synthetic positioned-line fixtures — NO real corporate PDFs are committed.
 * Fixture layout mirrors the actual PDF structure (verified by extracting real statements):
 *   - Page 1: header region, then "Account Activity Details" section
 *   - Transactions: "DD Mon" date prefix, description, [debit_or_credit, balance] columns
 *   - Date-less continuation rows (x≈90) are independent transactions with inherited date
 *   - Opening/closing balance rows have no date prefix and are skipped as transactions
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PdfLine, PdfTextSpan } from '../src/import/pdf/types.js';
import {
  rbcBusinessBankingParser,
  parseRbcBusinessBankingHeader,
  parseRbcBusinessBankingActivity,
} from '../src/import/pdf/rbcBusinessBanking.js';

// ─── Fixture helpers ──────────────────────────────────────────────────────────

/**
 * Build a PdfLine as if the text was rendered at the given x-position.
 * x=45 → date-prefixed transaction row; x=90 → date-less row.
 */
function mkLine(text: string, page = 1, y = 0, x = 45): PdfLine {
  const span: PdfTextSpan = { x, width: text.length * 5, str: text.trim() };
  return { page, y, text: ' ' + text, items: [span] };
}

function mkHeaderLine(text: string, page = 1, y = 0): PdfLine {
  return { page, y, text };
}

// ─── Synthetic fixture: single-transaction statement ─────────────────────────
//
// Mirrors: "Chequing Statement-4881 2026-05-05.pdf"
//   Period: April 2, 2026 to May 5, 2026
//   Opening balance: $266.80
//   01 May   Monthly fee   6.00   260.80   (debit)
//   Closing balance: $260.80

const SINGLE_TXN_LINES: PdfLine[] = [
  // Header region (page 1)
  mkHeaderLine(' P.O. BOX 4047 TERMINAL A                                 Business Account Statement', 1, 721),
  mkHeaderLine(' April 2, 2026 to May 5, 2026', 1, 664),
  mkHeaderLine('RBBDA30000_4689872 E D 03592   00380', 1, 660),
  mkHeaderLine(' CDG LABS INC.', 1, 647),
  mkHeaderLine(' Account number:   03592   105-488-1', 1, 632),
  mkHeaderLine(' TM', 1, 496),
  mkHeaderLine(' RBC Digital Choice Business            account package', 1, 492),
  // Account summary
  mkHeaderLine(' Opening balance on April 2, 2026   $266.80', 1, 449),
  // Activity section
  mkHeaderLine(' Account Activity Details', 1, 342),
  mkLine('Date   Description   Cheques & Debits ($)   Deposits & Credits ($)   Balance ($)', 1, 321, 45),
  mkLine('Opening balance   266.80', 1, 307, 90),
  mkLine('01 May   Monthly fee   6.00   260.80', 1, 293, 45),
  mkLine('Closing balance   260.80', 1, 278, 90),
];

// ─── Synthetic fixture: multi-transaction statement with date-less rows ───────
//
// Mirrors: "Chequing Statement-4881 2025-11-05.pdf"
//   Period: October 3, 2025 to November 5, 2025
//   Opening balance: -$6.00
//   17 Oct   Overdraft interest @ RBP+05.00%P.A   0.02   -6.02   (debit)
//   20 Oct   Misc Payment CDG LABS INC   7,294.46                 (credit, no balance shown)
//            Investment WS Investments   5,000.00   2,288.44      (debit, date-less row)
//   03 Nov   Monthly fee   6.00   2,282.44                        (debit)
//   05 Nov   Misc Payment CDG LABS INC   7,326.92   9,609.36      (credit)
//   Closing balance: $9,609.36

const MULTI_TXN_LINES: PdfLine[] = [
  mkHeaderLine(' P.O. BOX 4047 TERMINAL A                                 Business Account Statement', 1, 721),
  mkHeaderLine(' October 3, 2025 to November 5, 2025', 1, 664),
  mkHeaderLine('RBBDA30000_4689872 E D 03592   00380', 1, 660),
  mkHeaderLine(' CDG LABS INC.', 1, 647),
  mkHeaderLine(' Account number:   03592   105-488-1', 1, 632),
  mkHeaderLine(' RBC Digital Choice Business            account package', 1, 492),
  mkHeaderLine(' Account Activity Details', 1, 342),
  mkLine('Date   Description   Cheques & Debits ($)   Deposits & Credits ($)   Balance ($)', 1, 321, 45),
  mkLine('Opening balance   -6.00', 1, 307, 90),
  mkLine('17 Oct   Overdraft interest   @ RBP+05.00%P.A   0.02   -6.02', 1, 293, 45),
  mkLine('20 Oct   Misc Payment   CDG LABS INC   7,294.46', 1, 278, 45),
  mkLine('Investment   WS Investments   5,000.00   2,288.44', 1, 264, 90),
  mkLine('03 Nov   Monthly fee   6.00   2,282.44', 1, 249, 45),
  mkLine('05 Nov   Misc Payment   CDG LABS INC   7,326.92   9,609.36', 1, 235, 45),
  mkLine('Closing balance   9,609.36', 1, 220, 90),
];

// ─── Synthetic fixture: year-boundary statement (Dec → Jan) ──────────────────
//
// Period: December 5, 2025 to January 5, 2026
// Opening balance: 2,242.48
// 17 Dec   Misc Payment   CDG LABS INC   7,139.68   9,382.16   (credit)
// 18 Dec   Investment   WS Investments   9,000.00   382.16      (debit)
// 02 Jan   Misc Payment   CDG LABS INC   7,136.04   7,518.20   (credit)
//          Monthly fee   6.00   7,512.20                        (debit, date-less)
// Closing balance: 7,512.20

const YEAR_BOUNDARY_LINES: PdfLine[] = [
  mkHeaderLine(' Business Account Statement', 1, 721),
  mkHeaderLine(' December 5, 2025 to January 5, 2026', 1, 664),
  mkHeaderLine('RBBDA30000_4689872 E D 03592   00380', 1, 660),
  mkHeaderLine(' CDG LABS INC.', 1, 647),
  mkHeaderLine(' Account number:   03592   105-488-1', 1, 632),
  mkHeaderLine(' RBC Digital Choice Business            account package', 1, 492),
  mkHeaderLine(' Account Activity Details', 1, 342),
  mkLine('Date   Description   Cheques & Debits ($)   Deposits & Credits ($)   Balance ($)', 1, 321, 45),
  mkLine('Opening balance   2,242.48', 1, 307, 90),
  mkLine('17 Dec   Misc Payment   CDG LABS INC   7,139.68   9,382.16', 1, 293, 45),
  mkLine('18 Dec   Investment   WS Investments   9,000.00   382.16', 1, 278, 45),
  mkLine('02 Jan   Misc Payment   CDG LABS INC   7,136.04   7,518.20', 1, 264, 45),
  mkLine('Monthly fee   6.00   7,512.20', 1, 249, 90),
  mkLine('Closing balance   7,512.20', 1, 234, 90),
];

// ─── sniff() tests ────────────────────────────────────────────────────────────

test('rbcBusinessBankingParser sniff matches "Business Account Statement"', () => {
  assert.equal(
    rbcBusinessBankingParser.sniff([
      { page: 1, y: 721, text: ' P.O. BOX 4047 TERMINAL A                                 Business Account Statement' },
    ]),
    true,
  );
});

test('rbcBusinessBankingParser sniff rejects personal banking title', () => {
  assert.equal(
    rbcBusinessBankingParser.sniff([
      { page: 1, y: 0, text: 'Your RBC personal banking account statement' },
    ]),
    false,
  );
});

test('rbcBusinessBankingParser sniff rejects unrelated text', () => {
  assert.equal(
    rbcBusinessBankingParser.sniff([
      { page: 1, y: 0, text: 'CIBC Costco Mastercard Statement' },
    ]),
    false,
  );
});

// ─── header parsing tests ─────────────────────────────────────────────────────

test('parseRbcBusinessBankingHeader extracts accountSuffix from account number', () => {
  const header = parseRbcBusinessBankingHeader(SINGLE_TXN_LINES);
  assert.equal(header.accountSuffix, '4881');
});

test('parseRbcBusinessBankingHeader extracts statement period (no "From" prefix)', () => {
  const header = parseRbcBusinessBankingHeader(SINGLE_TXN_LINES);
  assert.equal(header.periodStart, '2026-04-02');
  assert.equal(header.periodEnd, '2026-05-05');
});

test('parseRbcBusinessBankingHeader sets accountType to checking', () => {
  const header = parseRbcBusinessBankingHeader(SINGLE_TXN_LINES);
  assert.equal(header.accountType, 'checking');
});

test('parseRbcBusinessBankingHeader extracts productLabel', () => {
  const header = parseRbcBusinessBankingHeader(SINGLE_TXN_LINES);
  // productLabel should start with "RBC Digital Choice Business"
  assert.ok(
    header.productLabel.startsWith('RBC Digital Choice Business'),
    `Expected productLabel to start with "RBC Digital Choice Business", got: ${header.productLabel}`,
  );
});

test('parseRbcBusinessBankingHeader extracts accountHolder (corp name)', () => {
  const header = parseRbcBusinessBankingHeader(SINGLE_TXN_LINES);
  assert.ok(
    header.accountHolder?.includes('CDG LABS'),
    `Expected accountHolder to include "CDG LABS", got: ${header.accountHolder}`,
  );
});

test('parseRbcBusinessBankingHeader handles year-boundary period', () => {
  const header = parseRbcBusinessBankingHeader(YEAR_BOUNDARY_LINES);
  assert.equal(header.periodStart, '2025-12-05');
  assert.equal(header.periodEnd, '2026-01-05');
});

// ─── transaction parsing: single debit ───────────────────────────────────────

test('parseRbcBusinessBankingActivity: single debit (monthly fee)', () => {
  const period = { start: '2026-04-02', end: '2026-05-05' };
  const { rows, parseErrors } = parseRbcBusinessBankingActivity(SINGLE_TXN_LINES, period, 266.80);

  assert.equal(rows.length, 1, `Expected 1 row, got ${rows.length}`);
  assert.equal(rows[0].date, '2026-05-01');
  assert.ok(rows[0].description.includes('Monthly fee'), `desc: ${rows[0].description}`);
  assert.equal(rows[0].amount, -6.00); // debit = negative
  assert.equal(parseErrors.length, 0, `Unexpected parse errors: ${JSON.stringify(parseErrors)}`);
});

// ─── transaction parsing: full parse() including header ──────────────────────

test('rbcBusinessBankingParser.parse produces correct transaction for single debit', () => {
  const result = rbcBusinessBankingParser.parse(SINGLE_TXN_LINES, { defaultCurrency: 'CAD' });

  assert.equal(result.transactions.length, 1);
  const txn = result.transactions[0];
  assert.equal(txn.date, '2026-05-01');
  assert.ok(txn.merchantRaw.includes('Monthly fee'));
  assert.equal(txn.amount, -6.00);
  assert.equal(txn.currency, 'CAD');
  assert.equal(result.header?.accountSuffix, '4881');
  assert.equal(result.header?.accountType, 'checking');
});

// ─── transaction parsing: multi-transaction with date-less rows ───────────────

test('parseRbcBusinessBankingActivity: multi-txn with date-less debit row', () => {
  const period = { start: '2025-10-03', end: '2025-11-05' };
  const { rows, parseErrors } = parseRbcBusinessBankingActivity(MULTI_TXN_LINES, period, -6.00);

  // Expected: 5 transactions
  // 17 Oct overdraft interest debit -0.02
  // 20 Oct Misc Payment credit +7,294.46
  // 20 Oct Investment debit -5,000.00 (date-less row)
  // 03 Nov Monthly fee debit -6.00
  // 05 Nov Misc Payment credit +7,326.92
  assert.equal(rows.length, 5, `Expected 5 rows, got ${rows.length}: ${JSON.stringify(rows.map(r => r.description))}`);

  // Row 0: overdraft interest debit
  assert.equal(rows[0].date, '2025-10-17');
  assert.ok(rows[0].description.includes('Overdraft interest') || rows[0].description.includes('overdraft'), `desc[0]: ${rows[0].description}`);
  assert.equal(rows[0].amount, -0.02);

  // Row 1: Misc Payment credit (no balance shown on its line)
  assert.equal(rows[1].date, '2025-10-20');
  assert.ok(rows[1].description.includes('Misc Payment'), `desc[1]: ${rows[1].description}`);
  assert.ok(rows[1].amount > 0, `Expected positive credit, got ${rows[1].amount}`);
  assert.equal(rows[1].amount, 7294.46);

  // Row 2: Investment debit (date-less row, balance 2,288.44)
  assert.equal(rows[2].date, '2025-10-20'); // inherits date
  assert.ok(rows[2].description.includes('Investment'), `desc[2]: ${rows[2].description}`);
  assert.equal(rows[2].amount, -5000.00);

  // Row 3: Monthly fee debit
  assert.equal(rows[3].date, '2025-11-03');
  assert.ok(rows[3].description.includes('Monthly fee'), `desc[3]: ${rows[3].description}`);
  assert.equal(rows[3].amount, -6.00);

  // Row 4: Misc Payment credit
  assert.equal(rows[4].date, '2025-11-05');
  assert.ok(rows[4].description.includes('Misc Payment'), `desc[4]: ${rows[4].description}`);
  assert.equal(rows[4].amount, 7326.92);

  // No unexpected parse errors about sign resolution
  const signErrors = parseErrors.filter(e => e.message.includes('defaulting'));
  assert.equal(signErrors.length, 0, `Unexpected sign-resolution errors: ${JSON.stringify(signErrors)}`);
});

// ─── transaction parsing: year-boundary (Dec → Jan) ──────────────────────────

test('parseRbcBusinessBankingActivity: year-boundary with date-less debit row', () => {
  const period = { start: '2025-12-05', end: '2026-01-05' };
  const { rows, parseErrors } = parseRbcBusinessBankingActivity(YEAR_BOUNDARY_LINES, period, 2242.48);

  assert.equal(rows.length, 4, `Expected 4 rows: ${JSON.stringify(rows)}`);

  // 17 Dec credit
  assert.equal(rows[0].date, '2025-12-17');
  assert.equal(rows[0].amount, 7139.68);

  // 18 Dec debit
  assert.equal(rows[1].date, '2025-12-18');
  assert.equal(rows[1].amount, -9000.00);

  // 02 Jan credit
  assert.equal(rows[2].date, '2026-01-02');
  assert.equal(rows[2].amount, 7136.04);

  // Monthly fee debit (date-less row → inherits Jan 02)
  assert.equal(rows[3].date, '2026-01-02');
  assert.ok(rows[3].description.includes('Monthly fee'), `desc[3]: ${rows[3].description}`);
  assert.equal(rows[3].amount, -6.00);

  const signErrors = parseErrors.filter(e => e.message.includes('defaulting'));
  assert.equal(signErrors.length, 0, `Unexpected sign-resolution errors: ${JSON.stringify(signErrors)}`);
});

// ─── registry integration ─────────────────────────────────────────────────────

test('registry: rbcBusinessBankingParser is returned by findPdfParser', async () => {
  const mod = await import('../src/import/pdf/registry.js');
  mod.clearPdfParsersForTest();
  mod.registerBuiltInPdfParsers();

  const hit = mod.findPdfParser([
    { page: 1, y: 721, text: ' P.O. BOX 4047 TERMINAL A                                 Business Account Statement' },
  ]);
  assert.equal(hit?.id, 'rbc_business_banking');
});

test('registry: existing personal banking parser still resolves correctly after business parser added', async () => {
  const mod = await import('../src/import/pdf/registry.js');
  mod.clearPdfParsersForTest();
  mod.registerBuiltInPdfParsers();

  const hit = mod.findPdfParser([
    { page: 1, y: 0, text: 'Your RBC personal banking account statement' },
  ]);
  assert.equal(hit?.id, 'rbc_personal_banking');
});

// ─── Fix 1: Statement-level reconciliation gate ───────────────────────────────

// Fixture: a statement where a transaction amount is deliberately mismatched
// vs the balance delta — simulating a parse corruption.
// Opening: 1000.00, one txn that claims rawAmount=50.00 but balance jumps only
// 10.00 → the balance delta signs it as -10.00, but closing says 990.00.
// opening 1000 + (-50) = 950  ≠  closing 990 → reconciliation fails.
//
// To build this: opening=1000, txn1 debit 50.00 balance=950.00, then closing=990.00 (lie).
// Sums: opening(1000) + (-50) = 950 ≠ 990 → gate must fire.
const MAGNITUDE_MISMATCH_LINES: PdfLine[] = [
  mkHeaderLine(' Business Account Statement', 1, 721),
  mkHeaderLine(' March 1, 2026 to April 1, 2026', 1, 664),
  mkHeaderLine('RBBDA30000_4689872 E D 03592   00380', 1, 660),
  mkHeaderLine(' CDG LABS INC.', 1, 647),
  mkHeaderLine(' Account number:   03592   105-488-1', 1, 632),
  mkHeaderLine(' RBC Digital Choice Business            account package', 1, 492),
  // Closing balance in Account Summary (wrong — doesn't match opening + txns)
  mkHeaderLine(' Closing balance on April 1, 2026   $990.00', 1, 440),
  mkHeaderLine(' Account Activity Details', 1, 342),
  mkLine('Date   Description   Cheques & Debits ($)   Deposits & Credits ($)   Balance ($)', 1, 321, 45),
  mkLine('Opening balance   1,000.00', 1, 307, 90),
  mkLine('15 Mar   Monthly fee   50.00   950.00', 1, 293, 45),
  mkLine('Closing balance   990.00', 1, 278, 90),
];

test('reconciliation gate fires when statement does not reconcile (magnitude mismatch)', () => {
  const result = rbcBusinessBankingParser.parse(MAGNITUDE_MISMATCH_LINES, { defaultCurrency: 'CAD' });
  const reconErrors = result.parseErrors.filter(e => e.message.includes('does not reconcile'));
  assert.ok(
    reconErrors.length > 0,
    `Expected a reconciliation parseError, got: ${JSON.stringify(result.parseErrors)}`,
  );
});

// ─── Fix 2: Ambiguity guard for net-zero offsetting pair ─────────────────────

// Fixture: two consecutive no-balance rows where both are equal magnitude
// (e.g. 100.00 each), so totalDelta=0. Both [+100,-100] and [-100,+100]
// satisfy totalDelta=0 within tolerance — ambiguous. Parser must flag this.
// Opening: 500.00, row1: +100 no-balance, row2: -100 no-balance, then row3
// with balance=500.00 (net delta=0). Closing: 500.00.
const NET_ZERO_AMBIGUOUS_LINES: PdfLine[] = [
  mkHeaderLine(' Business Account Statement', 1, 721),
  mkHeaderLine(' March 1, 2026 to April 1, 2026', 1, 664),
  mkHeaderLine('RBBDA30000_4689872 E D 03592   00380', 1, 660),
  mkHeaderLine(' CDG LABS INC.', 1, 647),
  mkHeaderLine(' Account number:   03592   105-488-1', 1, 632),
  mkHeaderLine(' RBC Digital Choice Business            account package', 1, 492),
  mkHeaderLine(' Closing balance on April 1, 2026   $500.00', 1, 440),
  mkHeaderLine(' Account Activity Details', 1, 342),
  mkLine('Date   Description   Cheques & Debits ($)   Deposits & Credits ($)   Balance ($)', 1, 321, 45),
  mkLine('Opening balance   500.00', 1, 307, 90),
  // Two consecutive no-balance rows of the same magnitude; netDelta=0 → ambiguous sign
  mkLine('10 Mar   Incoming payment   100.00', 1, 293, 45),
  mkLine('Outgoing payment   100.00   500.00', 1, 279, 90),
  mkLine('Closing balance   500.00', 1, 265, 90),
];

test('ambiguity guard fires for net-zero offsetting no-balance pair', () => {
  const period = { start: '2026-03-01', end: '2026-04-01' };
  const { parseErrors } = parseRbcBusinessBankingActivity(NET_ZERO_AMBIGUOUS_LINES, period, 500.00);
  const ambigErrors = parseErrors.filter(e => e.message.includes('ambiguous'));
  assert.ok(
    ambigErrors.length > 0,
    `Expected an ambiguity parseError, got: ${JSON.stringify(parseErrors)}`,
  );
});

// ─── Fix 1: Happy reconcile (no parseError) ───────────────────────────────────

// A well-formed multi-txn statement (debit + credit) where opening + signed = closing.
// Uses the MULTI_TXN_LINES fixture which has verified balances.
// We add a closing-balance summary line so the gate can extract the closing balance.
const MULTI_TXN_WITH_SUMMARY: PdfLine[] = [
  mkHeaderLine(' P.O. BOX 4047 TERMINAL A                                 Business Account Statement', 1, 721),
  mkHeaderLine(' October 3, 2025 to November 5, 2025', 1, 664),
  mkHeaderLine('RBBDA30000_4689872 E D 03592   00380', 1, 660),
  mkHeaderLine(' CDG LABS INC.', 1, 647),
  mkHeaderLine(' Account number:   03592   105-488-1', 1, 632),
  mkHeaderLine(' RBC Digital Choice Business            account package', 1, 492),
  // Correct closing balance: -6 + (-0.02) + 7294.46 + (-5000) + (-6) + 7326.92 = 9609.36
  mkHeaderLine(' Closing balance on November 5, 2025   $9,609.36', 1, 448),
  mkHeaderLine(' Account Activity Details', 1, 342),
  mkLine('Date   Description   Cheques & Debits ($)   Deposits & Credits ($)   Balance ($)', 1, 321, 45),
  mkLine('Opening balance   -6.00', 1, 307, 90),
  mkLine('17 Oct   Overdraft interest   @ RBP+05.00%P.A   0.02   -6.02', 1, 293, 45),
  mkLine('20 Oct   Misc Payment   CDG LABS INC   7,294.46', 1, 278, 45),
  mkLine('Investment   WS Investments   5,000.00   2,288.44', 1, 264, 90),
  mkLine('03 Nov   Monthly fee   6.00   2,282.44', 1, 249, 45),
  mkLine('05 Nov   Misc Payment   CDG LABS INC   7,326.92   9,609.36', 1, 235, 45),
  mkLine('Closing balance   9,609.36', 1, 220, 90),
];

test('reconciliation gate passes cleanly for a correct multi-txn statement', () => {
  const result = rbcBusinessBankingParser.parse(MULTI_TXN_WITH_SUMMARY, { defaultCurrency: 'CAD' });
  const reconErrors = result.parseErrors.filter(e => e.message.includes('does not reconcile'));
  assert.equal(
    reconErrors.length,
    0,
    `Expected no reconciliation errors, got: ${JSON.stringify(reconErrors)}`,
  );
  assert.equal(result.transactions.length, 5, `Expected 5 transactions, got ${result.transactions.length}`);
});
