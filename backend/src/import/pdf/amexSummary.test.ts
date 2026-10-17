/**
 * Amex statement summary → closing/opening balance, minimum and due date.
 *
 * Fixtures are synthetic page-1 lines mirroring the layout `extractPdfLines`
 * produces for real Amex Canada statements (labels, column order, spacing),
 * with made-up names, account numbers and amounts.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PdfLine, PdfParseResult } from './types';
import { amexParser } from './amex';
import { amexReserveParser } from './amexReserve';
import { parseAmexStatementSummary } from './amexSummary';
import { sequelize, Account, Household } from '../../models';
import { captureStatementBalance } from '../captureStatementBalance';
import type { StatementPreview } from '../statementTypes';

after(async () => {
  await sequelize.close();
});

/** The header's bill fields — what applyCreditCardStatementSummary reads. */
function billOf(out: PdfParseResult) {
  assert.ok(out.header);
  const { statementBalance, minimumPayment, paymentDueDate } = out.header;
  return { statementBalance, minimumPayment, paymentDueDate };
}

function page1(texts: string[]): PdfLine[] {
  return texts.map((text, i) => ({ page: 1, y: 800 - i * 10, text, items: [{ x: 17, width: 100, str: text }] }));
}

const RESERVE_TOP = [
  '  American Express® Aeroplan®* Reserve Card         1-800-000-0000 (toll free)',
  ' Statement of Account',
  '  Prepared For   Account Number   Opening Date   Closing Date',
  '  JANE DOE                         XXXX XXXXX9 99999   Aug 25, 2026   Sep 24, 2026',
  ' ACCOUNT SUMMARY',
];

const COBALT_TOP = [
  '  American Express Cobalt Card                      1-800-000-0000 (toll free)',
  ' Statement of Account',
  '  Prepared For   Account Number   Opening Date   Closing Date',
  '  JANE DOE                         XXXX XXXXX9 88888   Nov 24, 2022   Dec 23, 2022',
  ' ACCOUNT SUMMARY',
];

/** The ACCOUNT SUMMARY block: Credit Limit columns share the balance lines. */
function summaryBlock(previous: string, payments: string, purchases: string, newBalance: string, due: string, min: string): string[] {
  return [
    `Previous Balance                               ${previous} Credit Limit   $20,000.00`,
    `Less   Payments   ${payments} Available Credit Limit   $15,000.00`,
    'Less   Other Credits   $0.00 Available Cash Limit   $4,000.00',
    'Plus   Interest   $0.00',
    'To request a credit line increase, please go to  americanexpress.com/canada/request-limit-',
    `Plus   Purchases   ${purchases}`,
    'Plus   Fees   $0.00',
    'Plus   Credit Advances   $0.00',
    'Plus   Other Charges   $0.00',
    `Equals New Balance                                ${newBalance}`,
    'Payment Period Remaining',
    `Minimum Amount Due on ${due}   ${min}   If each month you pay the Minimum Amount Due only   12 Year(s) 4 Month(s)`,
  ];
}

/** The detachable payment coupon at the bottom of page 1. */
function coupon(newBalance: string, min: string, due: string): string[] {
  return [
    ' AMERICAN EXPRESS                          Account Number         XXXX XXXXX9 99999',
    `PLEASE ALLOW 3 TO 5 BUSINESS DAYS FOR YOUR PAYMENT TO BE                New Balance   ${newBalance}`,
    `PROCESSED BY YOUR FINANCIAL INSTITUTION AND SENT TO US.                  Minimum Due   ${min}`,
    `Learn about all of your payment options, including how to enroll your bank account,       Payment Due Date   ${due}`,
  ];
}

const FINE_PRINT = [
  'Payment Period Remaining - This is an estimate of the time it will take for you to pay off the New Balance shown on this statement if',
  'you make no additional charges using this Card and each month you pay the Minimum Amount Due only. For additional information including',
];

test('Reserve: reads New/Previous Balance, minimum and due date from the summary block', () => {
  const lines = page1([
    ...RESERVE_TOP,
    ...summaryBlock('$1,111.11', '$1,111.11', '$2,345.67', '$2,345.67', 'Oct 15, 2026', '$10.00'),
    ...coupon('$2,345.67', '$10.00', 'Oct 15, 2026'),
  ]);
  const out = amexReserveParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.deepEqual(billOf(out), { statementBalance: 2345.67, minimumPayment: 10, paymentDueDate: '2026-10-15' });
  // Liabilities carry the amount owed, positive — the Credit Limit sharing the
  // Previous Balance line is not mistaken for the opening balance.
  assert.deepEqual(out.statementBalances, { opening: 1111.11, closing: 2345.67 });
});

test('Cobalt: a first statement opens at $0.00 and five-figure balances parse', () => {
  const lines = page1([
    ...COBALT_TOP,
    ...summaryBlock('$0.00', '$0.00', '$12,345.60', '$12,345.60', 'Jan 13, 2023', '$123.45'),
    ...coupon('$12,345.60', '$123.45', 'Jan 13, 2023'),
    ...FINE_PRINT,
  ]);
  const out = amexParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.deepEqual(billOf(out), { statementBalance: 12345.6, minimumPayment: 123.45, paymentDueDate: '2023-01-13' });
  assert.deepEqual(out.statementBalances, { opening: 0, closing: 12345.6 });
});

test('coupon only: falls back to the payment coupon when the summary block is absent', () => {
  const lines = page1([...RESERVE_TOP, ...coupon('$987.65', '$15.00', 'Mar 9, 2026')]);
  assert.deepEqual(parseAmexStatementSummary(lines), {
    newBalance: 987.65,
    previousBalance: null,
    minimumPayment: 15,
    paymentDueDate: '2026-03-09',
  });
  const out = amexReserveParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.deepEqual(out.statementBalances, { opening: null, closing: 987.65 });
});

test('credit balances (leading minus or trailing CR) come out negative', () => {
  const lines = page1([
    ...RESERVE_TOP,
    ...summaryBlock('$120.00 CR', '$0.00', '$74.90', '-$45.10', 'Oct 15, 2026', '$0.00'),
  ]);
  const summary = parseAmexStatementSummary(lines);
  assert.equal(summary.previousBalance, -120);
  assert.equal(summary.newBalance, -45.1);
  assert.equal(summary.minimumPayment, 0);
  const out = amexReserveParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.deepEqual(out.statementBalances, { opening: -120, closing: -45.1 });
});

test('only page 1 is read: summary-like lines on later pages are ignored', () => {
  const lines = [
    ...page1(RESERVE_TOP),
    { page: 3, y: 500, text: 'Equals New Balance   $5.00' },
  ];
  assert.equal(parseAmexStatementSummary(lines).newBalance, null);
});

test('balance missing: no statementBalances and no statement balance on the header', () => {
  const out = amexReserveParser.parse(page1([...RESERVE_TOP, ...FINE_PRINT]), { defaultCurrency: 'CAD' });
  assert.equal(out.statementBalances, undefined);
  assert.deepEqual(billOf(out), { statementBalance: null, minimumPayment: null, paymentDueDate: null });
});

test('balance missing: the import still warns that the statement balance was not read', async () => {
  await sequelize.sync({ force: true });
  const hh = await Household.create({ name: 'H' } as never);
  const account = await Account.create({
    householdId: hh.id, name: 'Amex', accountType: 'credit_card', owner: 'me',
    visibility: 'private', defaultCurrency: 'CAD', shortCode: '999999',
  } as never);
  const { parseStatementFile } = await import('../parseStatementFile');
  const preview = (await parseStatementFile({
    buffer: Buffer.from('not a real pdf'),
    fileName: 'amex.pdf',
    accountId: account.id,
    householdId: hh.id,
    preExtractedLines: page1([...RESERVE_TOP, ...FINE_PRINT]),
  })) as StatementPreview;
  assert.deepEqual(preview.statementSummary, {
    periodStart: '2026-08-25',
    periodEnd: '2026-09-24',
    openingBalance: null,
    closingBalance: null,
  });
  const warnings = await captureStatementBalance(preview, account, null, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^Statement balance not read/);
});
