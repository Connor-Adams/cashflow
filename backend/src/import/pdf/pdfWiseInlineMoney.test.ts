import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PdfLine } from './types';
import { wiseStatementParser } from './wiseStatement';

function mk(text: string, page = 1, y = 0): PdfLine {
  return { page, y, text };
}

// Wise changed the statement layout: the Incoming/Outgoing/Amount columns are
// now printed ON the description line instead of on a line of their own, so a
// transaction occupies TWO lines rather than three:
//
//   Sent money to CDG Labs Inc.   -14,522.37   0.00
//   31 August 2026 | Transaction: TRANSFER-2342231594
//
// Every line below is copied verbatim from
// statement_1250415{70_CAD,619_USD}_2026-05-01_2026-09-15.pdf, whose import
// failed with "10/12 row(s) could not be parsed" — the old walker looked for a
// money-only line, never found one, and rejected every row.

function cadStmtHeader(): PdfLine[] {
  return [
    mk(' Wise Payments Canada Inc.'),
    mk(' CAD statement'),
    mk(' 1 May 2026 [GMT-04:00] - 15 September 2026 [GMT-04:00]'),
    mk(' Account Holder                                         Account number             Institution number'),
    mk(' CDG Labs Inc.                                         200116984719                    621'),
    mk(' CAD on 15 September 2026 [GMT-04:00]   0.00 CAD'),
    mk(' Description   Incoming   Outgoing   Amount'),
  ];
}

function usdStmtHeader(): PdfLine[] {
  return [
    mk(' Wise Payments Canada Inc.'),
    mk(' USD statement'),
    mk(' 1 May 2026 [GMT-04:00] - 15 September 2026 [GMT-04:00]'),
    mk(' Account Holder                                         Account number             Routing number'),
    mk(' CDG Labs Inc.                                         211862849418                    101019628'),
    mk(' USD on 15 September 2026 [GMT-04:00]   0.00 USD'),
    mk(' Description   Incoming   Outgoing   Amount'),
  ];
}

test('Wise inline-money: outgoing row takes the signed amount, not the balance', () => {
  const result = wiseStatementParser.parse(
    [
      ...cadStmtHeader(),
      mk(' Sent money to CDG Labs Inc.   -14,522.37   0.00'),
      mk(' 31 August 2026 | Transaction: TRANSFER-2342231594'),
    ],
    { defaultCurrency: 'CAD' },
  );
  assert.deepEqual(result.parseErrors, []);
  assert.equal(result.transactions.length, 1);
  const t = result.transactions[0];
  assert.equal(t.date, '2026-08-31');
  assert.equal(t.amount, -14522.37, 'trailing 0.00 is the running balance, not the amount');
  assert.equal(t.sourceReference, 'TRANSFER-2342231594');
  assert.equal(t.currency, 'CAD');
});

test('Wise inline-money: amounts embedded in the description text are not mistaken for columns', () => {
  // "Converted 10,499.28 USD to 14,522.37 CAD" puts two money tokens INSIDE the
  // description, ahead of the real columns. The amount is the second-to-last
  // token on the line; the last is the running balance.
  const result = wiseStatementParser.parse(
    [
      ...cadStmtHeader(),
      mk(' Converted 10,499.28 USD to 14,522.37 CAD   14,522.37   14,522.37'),
      mk(' 31 August 2026 | Transaction: BALANCE-5977871218'),
    ],
    { defaultCurrency: 'CAD' },
  );
  assert.deepEqual(result.parseErrors, []);
  assert.equal(result.transactions[0].amount, 14522.37);
  assert.equal(result.transactions[0].sourceReference, 'BALANCE-5977871218');
});

test('Wise inline-money: a long digit-only reference is not read as money', () => {
  const result = wiseStatementParser.parse(
    [
      ...usdStmtHeader(),
      mk(' Received money from WANDERCOM with reference 021000029613753   5,207.60   5,207.60'),
      mk(' 15 May 2026 | Transaction: TRANSFER-2135152417 | Reference: 021000029613753'),
    ],
    { defaultCurrency: 'USD' },
  );
  assert.deepEqual(result.parseErrors, []);
  assert.equal(result.transactions[0].amount, 5207.6);
  assert.equal(result.transactions[0].date, '2026-05-15');
});

test('Wise inline-money: a description wrapped onto a second line keeps its amount', () => {
  // The columns sit on the FIRST fragment; the reference spills onto the next
  // line, and only then comes the date/txn-id line.
  const result = wiseStatementParser.parse(
    [
      ...usdStmtHeader(),
      mk(' Received money from RIPPLING PAYMENTS INC. with reference                           0.01   5,207.61'),
      mk(' 2026052702100002100009187067'),
      mk(' 27 May 2026 | Transaction: TRANSFER-2155491708 | Reference: 2026052702100002100009187067'),
    ],
    { defaultCurrency: 'USD' },
  );
  assert.deepEqual(result.parseErrors, []);
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].amount, 0.01);
  assert.match(result.transactions[0].merchantRaw, /RIPPLING PAYMENTS INC/);
});

test('Wise inline-money: the whole CAD statement parses with no errors', () => {
  const result = wiseStatementParser.parse(
    [
      ...cadStmtHeader(),
      mk(' Sent money to CDG Labs Inc.   -14,522.37   0.00'),
      mk(' 31 August 2026 | Transaction: TRANSFER-2342231594'),
      mk(' Converted 10,499.28 USD to 14,522.37 CAD   14,522.37   14,522.37'),
      mk(' 31 August 2026 | Transaction: BALANCE-5977871218'),
      mk(' Sent money to CDG Labs Inc.   -14,697.76   0.00'),
      mk(' 31 July 2026 | Transaction: TRANSFER-2282088152'),
      mk(' Converted 10,499.29 USD to 14,697.76 CAD   14,697.76   14,697.76'),
      mk(' 31 July 2026 | Transaction: BALANCE-5779673854'),
      mk(' Sent money to CDG Labs Inc.   -14,891.99   0.00'),
      mk(' 30 June 2026 | Transaction: TRANSFER-2221024656'),
      mk(' Converted 10,499.30 USD to 14,891.99 CAD   14,891.99   14,891.99'),
      mk(' 30 June 2026 | Transaction: BALANCE-5577373331'),
      mk(' Sent money to CDG Labs Inc.   -3,435.50   0.00'),
      mk(' 29 May 2026 | Transaction: TRANSFER-2160859204'),
      mk(' Converted 2,499.27 USD to 3,435.50 CAD   3,435.50   3,435.50'),
      mk(' 29 May 2026 | Transaction: BALANCE-5380357134'),
      mk(' Sent money to CDG Labs Inc.   -20,443.54   0.00'),
      mk(' 27 May 2026 | Transaction: TRANSFER-2156174974'),
      mk(' Converted 14,822.88 USD to 20,443.54 CAD   20,443.54   20,443.54'),
      mk(' 27 May 2026 | Transaction: BALANCE-5366839721'),
      mk(' Wise Payments Canada Inc is registered as a money service business with the Financial Transactions'),
    ],
    { defaultCurrency: 'CAD' },
  );
  assert.deepEqual(result.parseErrors, []);
  assert.equal(result.transactions.length, 10);
  // Conversions in, payouts out — the statement nets to zero over the period.
  const net = result.transactions.reduce((a, t) => a + t.amount, 0);
  assert.equal(Math.round(net * 100) / 100, 0);
});

test('Wise three-line layout still parses (older statements)', () => {
  const result = wiseStatementParser.parse(
    [
      ...cadStmtHeader(),
      mk('Sent money to CDG Labs Inc.'),
      mk('-14,223.53   0.00'),
      mk('April 30, 2026   Transaction: TRANSFER-2106203630'),
    ],
    { defaultCurrency: 'CAD' },
  );
  assert.deepEqual(result.parseErrors, []);
  assert.equal(result.transactions[0].amount, -14223.53);
});
