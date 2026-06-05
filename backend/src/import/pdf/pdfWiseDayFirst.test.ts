import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PdfLine } from './types';
import {
  parseWiseStatementHeader,
  wiseStatementParser,
} from './wiseStatement';
import { parseLongDate } from './dateHelpers';

// Fixtures below are copied verbatim from the real Connor-Adams personal Wise
// Canada PDFs (statement window 2023-03-11 → 2026-06-01, generated 2026-06-02).
// Unlike the older corp fixtures, these render dates DAY-FIRST ("11 March 2023",
// "20 June 2025"), card rows interpose "Card ending in NNNN  <Holder>" between
// the date and "Transaction:", and the EUR account is keyed by IBAN, not a
// numeric account number.

function mk(text: string, page = 1, y = 0): PdfLine {
  return { page, y, text };
}

test('parseLongDate accepts day-first "DD Month YYYY"', () => {
  assert.equal(parseLongDate('11 March 2023'), '2023-03-11');
  assert.equal(parseLongDate('1 June 2026'), '2026-06-01');
  assert.equal(parseLongDate('20 June 2025'), '2025-06-20');
});

test('parseLongDate still accepts month-first "Month DD, YYYY"', () => {
  assert.equal(parseLongDate('June 20, 2025'), '2025-06-20');
  assert.equal(parseLongDate('May 25, 2026'), '2026-05-25');
});

test('Wise header: day-first CAD period + 12-digit account number', () => {
  const lines: PdfLine[] = [
    mk('Wise Payments Canada Inc.'),
    mk('CAD statement'),
    mk('11 March 2023 [GMT-04:00] - 1 June 2026 [GMT-04:00]'),
    mk('Generated on: 2 June 2026'),
    mk('Account Holder                                  Account number               Institution number'),
    mk('Connor Douglas Greene Adams                       200110536324                      621'),
  ];
  const header = parseWiseStatementHeader(lines);
  assert.equal(header.currency, 'CAD');
  assert.equal(header.periodStart, '2023-03-11');
  assert.equal(header.periodEnd, '2026-06-01');
  assert.equal(header.accountSuffix, '6324');
  assert.equal(header.accountHolder, 'Connor Douglas Greene Adams');
});

test('Wise header: EUR account keyed by IBAN (no numeric account number)', () => {
  const lines: PdfLine[] = [
    mk('Wise Payments Canada Inc.'),
    mk('EUR statement'),
    mk('11 March 2023 [GMT-04:00] - 1 June 2026 [GMT-04:00]'),
    mk('Account Holder                                   IBAN                        Swift/BIC'),
    mk('Connor Douglas Greene Adams                        BE08 9052 4770 9513                 TRWIBEB1XXX'),
  ];
  const header = parseWiseStatementHeader(lines);
  assert.equal(header.currency, 'EUR');
  assert.equal(header.accountSuffix, '9513');
  assert.equal(header.accountHolder, 'Connor Douglas Greene Adams');
});

function cadDayFirstHeader(): PdfLine[] {
  return [
    mk('Wise Payments Canada Inc.'),
    mk('CAD statement'),
    mk('11 March 2023 [GMT-04:00] - 1 June 2026 [GMT-04:00]'),
    mk('Account Holder                                  Account number               Institution number'),
    mk('Connor Douglas Greene Adams                       200110536324                      621'),
    mk('CAD on 1 June 2026 [GMT-04:00]   0.00 CAD'),
    mk('Description   Incoming   Outgoing   Amount'),
  ];
}

test('Wise parse: day-first TRANSFER row with Reference', () => {
  const lines: PdfLine[] = [
    ...cadDayFirstHeader(),
    mk('Sent money to CDG Labs Inc.'),
    mk('-10.00   0.00'),
    mk('20 June 2025   Transaction: TRANSFER-1592387578   Reference: 695241'),
  ];
  const result = wiseStatementParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(result.transactions.length, 1);
  const t = result.transactions[0];
  assert.equal(t.date, '2025-06-20');
  assert.equal(t.amount, -10.0);
  assert.equal(t.sourceReference, 'TRANSFER-1592387578');
});

test('Wise parse: card row with "Card ending in / holder" between date and Transaction:', () => {
  const lines: PdfLine[] = [
    ...cadDayFirstHeader(),
    mk('Card transaction of 72.00 CHF issued by Sbb Geneve Geneve'),
    mk('-113.21   126.50'),
    mk('11 February 2025   Card ending in 5531   Connor Douglas Greene Adams   Transaction: CARD-2226236545'),
  ];
  const result = wiseStatementParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(result.transactions.length, 1);
  const t = result.transactions[0];
  assert.equal(t.date, '2025-02-11');
  assert.equal(t.amount, -113.21);
  assert.equal(t.sourceReference, 'CARD-2226236545');
  assert.equal(t.merchantRaw, 'Card transaction of 72.00 CHF issued by Sbb Geneve Geneve');
});

test('Wise parse: empty EUR statement yields header + zero rows, no parse errors', () => {
  const lines: PdfLine[] = [
    mk('Wise Payments Canada Inc.'),
    mk('EUR statement'),
    mk('11 March 2023 [GMT-04:00] - 1 June 2026 [GMT-04:00]'),
    mk('Account Holder                                   IBAN                        Swift/BIC'),
    mk('Connor Douglas Greene Adams                        BE08 9052 4770 9513                 TRWIBEB1XXX'),
    mk('EUR on 1 June 2026 [GMT-04:00]   0.00 EUR'),
    mk('Description   Incoming   Outgoing   Amount'),
    mk('Wise Payments Canada Inc is registered as a money service business with the Financial Transactions and Reports Analysis Centre of Canada'),
  ];
  const result = wiseStatementParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.ok(result.header);
  assert.equal(result.header!.currency, 'EUR');
  assert.equal(result.transactions.length, 0);
  assert.equal(result.parseErrors.length, 0);
});
