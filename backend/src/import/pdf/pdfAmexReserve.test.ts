import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PdfLine, PdfTextSpan } from './types';
import { parseAmexReserveHeader, amexReserveParser } from './amexReserve';

function mkLine(text: string, page = 1, y = 0, x = 18): PdfLine {
  const span: PdfTextSpan = { x, width: text.length * 5, str: text };
  return { page, y, text, items: [span] };
}

function mkAmountLine(amount: string, y = 0): PdfLine {
  const span: PdfTextSpan = { x: 500, width: amount.length * 5, str: amount };
  return { page: 2, y, text: amount, items: [span] };
}

function headerLines(): PdfLine[] {
  return [
    mkLine(' American Express® Aeroplan®* Reserve Card', 1, 790),
    mkLine(' CONNOR ADAMS                         XXXX XXXXX7 01001   Apr 25, 2026   May 24, 2026', 1, 689),
  ];
}

test('sniff — matches Reserve Card', () => {
  const lines = headerLines();
  assert.equal(amexReserveParser.sniff(lines), true);
});

test('sniff — rejects non-Amex', () => {
  const lines = [mkLine('CIBC Costco Mastercard')];
  assert.equal(amexReserveParser.sniff(lines), false);
});

test('parseAmexReserveHeader — extracts account, period, holder', () => {
  const hdr = parseAmexReserveHeader(headerLines());
  assert.equal(hdr.accountSuffix, '701001');
  assert.equal(hdr.periodStart, '2026-04-25');
  assert.equal(hdr.periodEnd, '2026-05-24');
  assert.equal(hdr.accountHolder, 'CONNOR ADAMS');
});

test('parse — row whose amount line never matches becomes a parse error, not a $0.00 transaction', () => {
  const lines = [
    ...headerLines(),
    mkLine('New Transactions for CONNOR ADAMS', 2, 560),
    mkLine('Apr 27   Apr 27   SOME MERCHANT   CITY', 2, 512),
    // Amount span at x ≤ 400 fails isAmountLine (layout drift) — the row's
    // amount is never attached.
    mkLine('38.26', 2, 510, 300),
    mkLine('Total of New Transactions for                                        38.26', 2, 400),
  ];
  const result = amexReserveParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(result.transactions.length, 0, `expected no $0 txn, got ${JSON.stringify(result.transactions)}`);
  assert.equal(result.parseErrors.length, 1);
  assert.ok(result.parseErrors[0].message.includes('SOME MERCHANT'));
});

test('parse — genuine 0.00 amount is kept and a later stray amount line does not attach to it', () => {
  const lines = [
    ...headerLines(),
    mkLine('New Transactions for CONNOR ADAMS', 2, 560),
    mkLine('Apr 27   Apr 27   ZERO DOLLAR AUTH   CITY', 2, 512),
    mkAmountLine('0.00', 510),
    mkAmountLine('50.00', 508),
    mkLine('Total of New Transactions for                                        0.00', 2, 400),
  ];
  const result = amexReserveParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].amount, 0);
  assert.deepEqual(result.warnings, []);
});

test('parse — basic charge', () => {
  const lines = [
    ...headerLines(),
    mkLine('New Transactions for CONNOR ADAMS', 2, 560),
    mkLine('Apr 27   Apr 27   AMZN MKTP CA*BS9LJ7ND0 866-216-1072', 2, 512),
    mkAmountLine('38.26', 510),
    mkLine('Total of New Transactions for                                        38.26', 2, 400),
  ];
  const result = amexReserveParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(result.transactions.length, 1);
  const t = result.transactions[0];
  assert.equal(t.date, '2026-04-27');
  assert.equal(t.merchantRaw, 'AMZN MKTP CA*BS9LJ7ND0 866-216-1072');
  assert.equal(t.amount, -38.26);
  assert.equal(t.currency, 'CAD');
  assert.equal(t.sourceReference, null);
  assert.equal(result.warnings.length, 0);
});

test('parse — payment with reference', () => {
  const lines = [
    ...headerLines(),
    mkLine('New Payments', 2, 632),
    mkLine('May 17   May 17   PAYMENT RECEIVED - THANK YOU', 2, 616),
    mkAmountLine('-5,981.24', 614),
    mkLine('Reference AT261370007000010005631', 2, 608, 97),
    mkLine('Total of Payment Activity   -5,981.24', 2, 590),
  ];
  const result = amexReserveParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(result.transactions.length, 1);
  const t = result.transactions[0];
  assert.equal(t.date, '2026-05-17');
  assert.equal(t.amount, 5981.24);
  assert.equal(t.sourceReference, 'AT261370007000010005631');
  assert.equal(result.warnings.length, 0);
});

test('parse — credit/refund gets positive amount', () => {
  const lines = [
    ...headerLines(),
    mkLine('New Transactions for CONNOR ADAMS', 2, 560),
    mkLine('May 8   May 8   APPLE.COM/BILL   TORONTO', 2, 365),
    mkAmountLine('-45.19', 363),
    mkLine('Total of New Transactions for                                        -45.19', 2, 350),
  ];
  const result = amexReserveParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].amount, 45.19);
});

test('parse — foreign currency detail appended to merchantRaw', () => {
  const lines = [
    ...headerLines(),
    mkLine('New Transactions for CONNOR ADAMS', 2, 560),
    mkLine('May 7   May 8   RAILWAY   SAN FRANCISCO', 2, 434),
    mkAmountLine('11.80', 432),
    mkLine('UNITED STATES DOLLAR 8.44    @ 1.39810', 2, 425, 100),
    mkLine('Total of New Transactions for                                        11.80', 2, 400),
  ];
  const result = amexReserveParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(result.transactions.length, 1);
  const t = result.transactions[0];
  assert.equal(t.amount, -11.80);
  assert.ok(t.merchantRaw.includes('[UNITED STATES DOLLAR 8.44 @ 1.3981]'));
  assert.ok(t.merchantClean.startsWith('RAILWAY'));
});

test('parse — European comma-as-decimal in FX amount', () => {
  const lines = [
    ...headerLines(),
    mkLine('New Transactions for CONNOR ADAMS', 2, 560),
    mkLine('May 7   May 8   CUBECODERS.COM   BRISTOL', 2, 387),
    mkAmountLine('31.18', 385),
    mkLine('EUROPEAN UNION EURO 19,00    @ 1.64105', 2, 378, 100),
    mkLine('Total of New Transactions for                                        31.18', 2, 350),
  ];
  const result = amexReserveParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(result.transactions.length, 1);
  assert.ok(result.transactions[0].merchantRaw.includes('[EUROPEAN UNION EURO 19.00 @ 1.64105]'));
});

test('parse — European dot-grouped thousands in FX amount (1.234,56 = 1234.56)', () => {
  const lines = [
    ...headerLines(),
    mkLine('New Transactions for CONNOR ADAMS', 2, 560),
    mkLine('May 7   May 8   HOTEL ADLON   BERLIN', 2, 387),
    mkAmountLine('2026.12', 385),
    mkLine('EUROPEAN UNION EURO 1.234,56    @ 1.64105', 2, 378, 100),
    mkLine('Total of New Transactions for                                        2026.12', 2, 350),
  ];
  const result = amexReserveParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(result.transactions.length, 1);
  assert.ok(
    result.transactions[0].merchantRaw.includes('[EUROPEAN UNION EURO 1234.56 @ 1.64105]'),
    `got: ${result.transactions[0].merchantRaw}`,
  );
});

test('parse — other account transactions (membership fee)', () => {
  const lines = [
    ...headerLines(),
    mkLine('Other Account Transactions', 2, 409),
    mkLine('Nov 24   Nov 24   MEMBERSHIP FEE', 2, 394),
    mkAmountLine('599.00', 392),
    mkLine('Total of Other Account Transactions   599.00', 2, 373),
  ];
  // Nov 24 is outside Apr 25 – May 24 period; use a header with matching period
  const hdrLines = [
    mkLine(' American Express® Aeroplan®* Reserve Card', 1, 790),
    mkLine(' CONNOR ADAMS                         XXXX XXXXX7 01001   Oct 25, 2024   Nov 24, 2024', 1, 689),
  ];
  const result = amexReserveParser.parse([...hdrLines, ...lines.slice(2)], { defaultCurrency: 'CAD' });
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].amount, -599.00);
  assert.equal(result.transactions[0].merchantRaw, 'MEMBERSHIP FEE');
});

test('parse — section totals cross-check emits warning on mismatch', () => {
  const lines = [
    ...headerLines(),
    mkLine('New Transactions for CONNOR ADAMS', 2, 560),
    mkLine('Apr 27   Apr 27   SOME MERCHANT   CITY', 2, 512),
    mkAmountLine('100.00', 510),
    mkLine('Total of New Transactions for                                        999.99', 2, 400),
  ];
  const result = amexReserveParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0].includes('sum mismatch'));
});

test('parse — multiple transactions in sequence', () => {
  const lines = [
    ...headerLines(),
    mkLine('New Payments', 2, 632),
    mkLine('May 17   May 17   PAYMENT RECEIVED - THANK YOU', 2, 616),
    mkAmountLine('-5000.00', 614),
    mkLine('Reference REF123', 2, 608, 97),
    mkLine('Total of Payment Activity   -5,000.00', 2, 590),
    mkLine('New Transactions for CONNOR ADAMS', 2, 560),
    mkLine('Apr 27   Apr 28   MERCHANT A   TORONTO', 2, 543),
    mkAmountLine('100.00', 541),
    mkLine('Apr 28   Apr 29   MERCHANT B   MONTREAL', 2, 527),
    mkAmountLine('200.00', 525),
    mkLine('Total of New Transactions for                                        300.00', 2, 400),
  ];
  const result = amexReserveParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(result.transactions.length, 3);
  assert.equal(result.transactions[0].amount, 5000.00);
  assert.equal(result.transactions[0].sourceReference, 'REF123');
  assert.equal(result.transactions[1].amount, -100.00);
  assert.ok(result.transactions[1].merchantClean.startsWith('MERCHANT A'));
  assert.equal(result.transactions[2].amount, -200.00);
  assert.equal(result.warnings.length, 0);
});

test('parse — header returned with correct shape', () => {
  const lines = [
    ...headerLines(),
    mkLine('Total of Payment Activity   0.00', 2, 632),
  ];
  const result = amexReserveParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.ok(result.header);
  assert.equal(result.header!.accountSuffix, '701001');
  assert.equal(result.header!.accountType, 'credit_card');
  assert.equal(result.header!.periodStart, '2026-04-25');
  assert.equal(result.header!.periodEnd, '2026-05-24');
  assert.equal(result.header!.accountHolder, 'CONNOR ADAMS');
  assert.equal(result.header!.productLabel, 'American Express Aeroplan Reserve Card');
});

test('parse — skips page headers and column labels', () => {
  const lines = [
    ...headerLines(),
    mkLine('New Transactions for CONNOR ADAMS', 2, 560),
    mkLine('Transaction  Posting      Details   Amount ($)', 2, 661),
    mkLine('Date        Date', 2, 654),
    mkLine('Page 2 / 7', 2, 753),
    mkLine('Statement of Account', 2, 771),
    mkLine(' American Express® Aeroplan®* Reserve Card', 2, 788),
    mkLine(' Prepared For   Account Number   Opening Date   Closing Date', 2, 715),
    mkLine('Apr 27   Apr 27   ONLY REAL TXN   CITY', 2, 512),
    mkAmountLine('50.00', 510),
    mkLine('Total of New Transactions for                                        50.00', 2, 400),
  ];
  const result = amexReserveParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].merchantRaw, 'ONLY REAL TXN   CITY');
});
