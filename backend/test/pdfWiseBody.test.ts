import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PdfLine } from '../src/import/pdf/types';
import { wiseStatementParser } from '../src/import/pdf/wiseStatement';

function mk(text: string, page = 1, y = 0): PdfLine {
  return { page, y, text };
}

// Wise PDFs lay each txn out on THREE successive lines:
//   1. description text
//   2. money pair "<signed amount>   <running balance>"
//   3. "<long date>   Transaction: <TXNID>   [Reference: <ref>]"
// Fixtures mirror that exactly.

function cadStmtHeader(): PdfLine[] {
  return [
    mk('Wise Payments Canada Inc.'),
    mk('CAD statement'),
    mk('June 20, 2025 [GMT-04:00] - May 25, 2026 [GMT-04:00]'),
    mk('Account Holder                        Account number                    Institution number'),
    mk('CDG Labs Inc.                             200116984719                             621'),
    mk('CAD on May 25, 2026 [GMT-04:00]   0.00 CAD'),
    mk('Description   Incoming   Outgoing   Amount'),
  ];
}

function usdStmtHeader(): PdfLine[] {
  return [
    mk('Wise Payments Canada Inc.'),
    mk('USD statement'),
    mk('June 20, 2025 [GMT-04:00] - May 25, 2026 [GMT-04:00]'),
    mk('Account Holder                        Account number                    Routing number'),
    mk('CDG Labs Inc.                             211862849418                             101019628'),
    mk('USD on May 25, 2026 [GMT-04:00]   5,207.60 USD'),
    mk('Description   Incoming   Outgoing   Amount'),
  ];
}

test('Wise parse: "Sent money" row emits negative amount + TXNID sourceReference', () => {
  const lines: PdfLine[] = [
    ...cadStmtHeader(),
    mk('Sent money to CDG Labs Inc.'),
    mk('-14,223.53   0.00'),
    mk('April 30, 2026   Transaction: TRANSFER-2106203630'),
  ];
  const result = wiseStatementParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(result.transactions.length, 1);
  const t = result.transactions[0];
  assert.equal(t.date, '2026-04-30');
  assert.equal(t.merchantRaw, 'Sent money to CDG Labs Inc.');
  assert.equal(t.amount, -14223.53);
  assert.equal(t.currency, 'CAD');
  assert.equal(t.sourceReference, 'TRANSFER-2106203630');
});

test('Wise parse: "Converted" inflow on CAD side (Incoming column) emits positive amount', () => {
  const lines: PdfLine[] = [
    ...cadStmtHeader(),
    mk('Converted 5,207.60 USD to 7,084.89 CAD'),
    mk('7,084.89   14,223.53'),
    mk('April 30, 2026   Transaction: BALANCE-5207451832'),
  ];
  const result = wiseStatementParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(result.transactions.length, 1);
  const t = result.transactions[0];
  assert.equal(t.amount, 7084.89);
  assert.equal(t.sourceReference, 'BALANCE-5207451832');
  assert.equal(t.merchantRaw, 'Converted 5,207.60 USD to 7,084.89 CAD');
});

test('Wise parse: "Converted" outflow on USD side (Outgoing column) emits negative amount', () => {
  const lines: PdfLine[] = [
    ...usdStmtHeader(),
    mk('Converted 5,207.60 USD to 7,084.89 CAD'),
    mk('-5,207.60   0.00'),
    mk('April 30, 2026   Transaction: BALANCE-5207451832'),
  ];
  const result = wiseStatementParser.parse(lines, { defaultCurrency: 'USD' });
  assert.equal(result.transactions.length, 1);
  const t = result.transactions[0];
  assert.equal(t.amount, -5207.60);
  assert.equal(t.currency, 'USD');
  assert.equal(t.sourceReference, 'BALANCE-5207451832');
});

test('Wise parse: "Received money" inflow with Reference captures TXNID (not the reference)', () => {
  const lines: PdfLine[] = [
    ...usdStmtHeader(),
    mk('Received money from WANDERCOM with reference 021000029613753'),
    mk('5,207.60   5,207.60'),
    mk('May 15, 2026   Transaction: TRANSFER-2135152417   Reference: 021000029613753'),
  ];
  const result = wiseStatementParser.parse(lines, { defaultCurrency: 'USD' });
  assert.equal(result.transactions.length, 1);
  const t = result.transactions[0];
  assert.equal(t.amount, 5207.60);
  assert.equal(t.date, '2026-05-15');
  assert.equal(t.sourceReference, 'TRANSFER-2135152417');
});

test('Wise parse: "Topped up account" positive amount', () => {
  const lines: PdfLine[] = [
    ...cadStmtHeader(),
    mk('Topped up account'),
    mk('55.00   55.00'),
    mk('June 20, 2025   Transaction: TRANSFER-1592155474'),
  ];
  const result = wiseStatementParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].amount, 55);
  assert.equal(result.transactions[0].sourceReference, 'TRANSFER-1592155474');
});

test('Wise parse: "Wise bank details acquisition" negative amount + invoice-form TXNID', () => {
  const lines: PdfLine[] = [
    ...cadStmtHeader(),
    mk('Wise bank details acquisition'),
    mk('-55.00   0.00'),
    mk('June 20, 2025   Transaction: BANK_DETAILS_ORDER_CHECKOUT-invoice-18274657'),
  ];
  const result = wiseStatementParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].amount, -55);
  assert.equal(
    result.transactions[0].sourceReference,
    'BANK_DETAILS_ORDER_CHECKOUT-invoice-18274657',
  );
});

test('Wise parse: multiple txns in same statement', () => {
  const lines: PdfLine[] = [
    ...cadStmtHeader(),
    mk('Sent money to CDG Labs Inc.'),
    mk('-14,223.53   0.00'),
    mk('April 30, 2026   Transaction: TRANSFER-2106203630'),
    mk('Converted 5,207.60 USD to 7,084.89 CAD'),
    mk('7,084.89   14,223.53'),
    mk('April 30, 2026   Transaction: BALANCE-5207451832'),
    mk('Converted 5,207.60 USD to 7,138.64 CAD'),
    mk('7,138.64   7,138.64'),
    mk('April 15, 2026   Transaction: BALANCE-5123719685'),
  ];
  const result = wiseStatementParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(result.transactions.length, 3);
  const refs = result.transactions.map((t) => t.sourceReference);
  assert.deepEqual(refs, [
    'TRANSFER-2106203630',
    'BALANCE-5207451832',
    'BALANCE-5123719685',
  ]);
});

test('Wise parse: header surfaced on result for bundle importer', () => {
  const lines: PdfLine[] = [
    ...cadStmtHeader(),
    mk('Sent money to CDG Labs Inc.'),
    mk('-14,223.53   0.00'),
    mk('April 30, 2026   Transaction: TRANSFER-2106203630'),
  ];
  const result = wiseStatementParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.ok(result.header);
  assert.equal(result.header!.currency, 'CAD');
  assert.equal(result.header!.accountHolder, 'CDG Labs Inc.');
  assert.equal(result.header!.accountSuffix, '4719');
  assert.equal(result.header!.productLabel, 'Wise CAD');
});

test('Wise parse: skips trailing footer + page footer + empty lines without parse errors', () => {
  const lines: PdfLine[] = [
    ...cadStmtHeader(),
    mk('Sent money to CDG Labs Inc.'),
    mk('-14,223.53   0.00'),
    mk('April 30, 2026   Transaction: TRANSFER-2106203630'),
    mk('ref:798b9ded-381e-4c42-a87b-d65bd293aeac   1 / 3'),
    mk(''),
    mk('Wise Payments Canada Inc is registered as a money service business with the Financial Transactions and Reports Analysis Centre of Canada'),
    mk('(FINTRAC) under registration number M15193392. Wise has an MSB licence with Revenu Quebec under business number 1171229694.'),
    mk('Need help? Visit wise.com/help'),
  ];
  const result = wiseStatementParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(result.transactions.length, 1);
  assert.equal(result.parseErrors.length, 0);
});

test('Wise parse: handles 3-line block split across page boundary', () => {
  // pdfjs preserves source line order across pages; the walker is page-agnostic.
  const lines: PdfLine[] = [
    ...cadStmtHeader(),
    mk('Sent money to CDG Labs Inc.', 1, 80),
    mk('ref:798b9ded-381e-4c42-a87b-d65bd293aeac   1 / 3', 1, 15),
    mk('-7,072.17   0.00', 2, 791),
    mk('February 13, 2026   Transaction: BALANCE-4798245138', 2, 778),
  ];
  const result = wiseStatementParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].amount, -7072.17);
  assert.equal(result.transactions[0].sourceReference, 'BALANCE-4798245138');
});
