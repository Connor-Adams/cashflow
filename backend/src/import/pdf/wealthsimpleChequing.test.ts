import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PdfLine } from './types';
import { wealthsimpleChequingParser } from './wealthsimpleChequing';

function mk(text: string, page = 1, y = 0): PdfLine {
  return { page, y, text };
}

// Every fixture line is copied verbatim from
// WK79NVW07CAD_identity-…_2026-08_v_0.pdf — a Wealthsimple Business chequing
// monthly statement, which had no parser at all.

function header(opening = '$10,274.80', closing = '$15,802.33'): PdfLine[] {
  return [
    mk('Chequing monthly statement'),
    mk('Wealthsimple    Aug 1 - Aug 31, 2026'),
    mk(' CDG Labs Inc.'),
    mk(' 485 Sandmere Place'),
    mk('Oakville, ON L6L4G5'),
    mk('Canada'),
    mk(' Account number:   44681757'),
    mk('AUG 1 BALANCE             AUG 31 BALANCE'),
    mk(' Your August summary'),
    mk(` ${opening}       ${closing}`),
    mk(' Activity'),
    mk(' DATE   POSTED DATE   DESCRIPTION   AMOUNT (CAD)   BALANCE (CAD)'),
  ];
}

test('WS chequing: sniffs its own statement and not another', () => {
  assert.equal(wealthsimpleChequingParser.sniff(header()), true);
  assert.equal(
    wealthsimpleChequingParser.sniff([mk('Credit card statement'), mk('Wealthsimple    Aug 15 — Sep 14, 2026')]),
    false,
  );
});

test('WS chequing: header carries period, currency, holder and account suffix', () => {
  const r = wealthsimpleChequingParser.parse(header(), { defaultCurrency: 'CAD' });
  assert.equal(r.header.accountType, 'checking');
  assert.equal(r.header.periodStart, '2026-08-01');
  assert.equal(r.header.periodEnd, '2026-08-31');
  assert.equal(r.header.currency, 'CAD');
  assert.equal(r.header.accountHolder, 'CDG Labs Inc.');
  assert.equal(r.header.accountSuffix, '1757');
});

test('WS chequing: credits are positive, debits negative', () => {
  const r = wealthsimpleChequingParser.parse(
    [
      ...header(),
      mk(' 2026-08-01   2026-08-01   Interest earned   $27.53   $10,302.33'),
      mk('2026-08-02   2026-08-03   Deposit   $14,500.00   $24,802.33'),
      mk('2026-08-03   2026-08-03   Transfer out to Chequing   –$1,000.00   $23,802.33'),
      mk('2026-08-13   2026-08-13   Transfer out to Chequing   –$8,000.00   $15,802.33'),
    ],
    { defaultCurrency: 'CAD' },
  );
  assert.deepEqual(r.parseErrors, []);
  assert.equal(r.transactions.length, 4);
  assert.deepEqual(
    r.transactions.map((t) => t.amount),
    [27.53, 14500, -1000, -8000],
  );
  assert.deepEqual(
    r.transactions.map((t) => t.merchantRaw),
    ['Interest earned', 'Deposit', 'Transfer out to Chequing', 'Transfer out to Chequing'],
  );
});

test('WS chequing: the minus sign is an EN DASH, not a hyphen', () => {
  // Wealthsimple prints –$1,000.00 (U+2013). Treating only '-' as negative
  // would flip every withdrawal into a deposit.
  const r = wealthsimpleChequingParser.parse(
    [...header(), mk('2026-08-03   2026-08-03   Transfer out to Chequing   –$1,000.00   $23,802.33')],
    { defaultCurrency: 'CAD' },
  );
  assert.equal(r.transactions[0].amount, -1000);
});

test('WS chequing: rows carry the transaction date, not the posted date', () => {
  // The statement advises using the posted date for accounting, but the CSV
  // export of this same account uses the transaction date — and dedup keys on
  // date, so parsing a statement for a month already loaded from CSV would
  // duplicate every row whose posting lagged.
  const r = wealthsimpleChequingParser.parse(
    [...header(), mk('2026-08-02   2026-08-03   Deposit   $14,500.00   $24,802.33')],
    { defaultCurrency: 'CAD' },
  );
  assert.equal(r.transactions[0].date, '2026-08-02');
});

test('WS chequing: prose and footers are not transactions', () => {
  const r = wealthsimpleChequingParser.parse(
    [
      ...header('$10,274.80', '$10,302.33'),
      mk(' 2026-08-01   2026-08-01   Interest earned   $27.53   $10,302.33'),
      mk(' Date   is when the transaction happened.'),
      mk(' Posted date   is when the transaction is processed and finalized. Use this for accounting purposes.'),
      mk('Page 1 of 2                                         Wealthsimple Payments Inc., 400 - 80 Spadina Ave'),
      mk('The advertised interest rate for the Business chequing account is derived from interest earned by Wealthsimple'),
    ],
    { defaultCurrency: 'CAD' },
  );
  assert.deepEqual(r.parseErrors, []);
  assert.equal(r.transactions.length, 1);
});

test('WS chequing: a statement with no activity parses to nothing, not an error', () => {
  const r = wealthsimpleChequingParser.parse(header('$10,274.80', '$10,274.80'), { defaultCurrency: 'CAD' });
  assert.deepEqual(r.transactions, []);
  assert.deepEqual(r.parseErrors, []);
});

// pdfjs sometimes splits a pair of 1s with a kerning gap: "$11,305.92" comes
// out as "$1 1,305.92" and "2026-09-11" as "2026-09-1 1". The strict row
// pattern then failed and the row was skipped without a word — the 2026-09
// personal statement lost +10,000 and +4,500 of transfers that way. Lines are
// verbatim from Chequing-monthly-statement-WK3DD9X35CAD-2026-09-v_0.pdf.
test('WS chequing: digits split by a kerning gap still parse', () => {
  const r = wealthsimpleChequingParser.parse(
    [
      ...header('$1,303.65', '$10,913.88'),
      mk('2026-09-01   2026-09-01   Interest earned   $2.27   $1,305.92'),
      mk('2026-09-06   2026-09-06   Transfer in from CDG Labs Inc.   $10,000.00   $1 1,305.92'),
      mk('2026-09-06   2026-09-06   Transfer out to Credit Card   –$4,738.22   $6,567.70'),
      mk('2026-09-09   2026-09-09   Transfer in from Business Investing   $4,500.00   $1 1,067.70'),
      mk('2026-09-09   2026-09-09   Cash sent   –$90.00   $10,977.70'),
      mk('2026-09-08   2026-09-10   Steamgames.com 4259522   –$7.33   $10,970.37'),
      mk('2026-09-1 1   2026-09-13   Wl *Steam Purchase   –$56.49   $10,913.88'),
    ],
    { defaultCurrency: 'CAD' },
  );
  assert.deepEqual(r.parseErrors, []);
  assert.deepEqual(
    r.transactions.map((t) => [t.date, t.amount]),
    [
      ['2026-09-01', 2.27],
      ['2026-09-06', 10000],
      ['2026-09-06', -4738.22],
      ['2026-09-09', 4500],
      ['2026-09-09', -90],
      ['2026-09-08', -7.33],
      ['2026-09-11', -56.49],
    ],
  );
});

test('WS chequing: emits the statement opening and closing balances', () => {
  const r = wealthsimpleChequingParser.parse(
    [...header('$10,274.80', '$10,302.33'), mk('2026-08-01   2026-08-01   Interest earned   $27.53   $10,302.33')],
    { defaultCurrency: 'CAD' },
  );
  assert.deepEqual(r.statementBalances, { opening: 10274.8, closing: 10302.33 });
});

test('WS chequing: a statement that does not reconcile is blocked, not silently short', () => {
  // A dropped row must surface: opening + rows ≠ closing → blocking error.
  const r = wealthsimpleChequingParser.parse(
    [...header('$1,303.65', '$11,305.92'), mk('2026-09-01   2026-09-01   Interest earned   $2.27   $1,305.92')],
    { defaultCurrency: 'CAD' },
  );
  assert.ok(r.parseErrors.some((e) => e.blocking), JSON.stringify(r.parseErrors));
});

test('WS chequing: a dated line it cannot read is reported, not skipped', () => {
  const r = wealthsimpleChequingParser.parse(
    [...header('$10,274.80', '$10,274.80'), mk('2026-08-05   2026-08-05   Something odd   $12.3   $10,274.80')],
    { defaultCurrency: 'CAD' },
  );
  assert.ok(
    r.parseErrors.some((e) => !e.blocking && e.message.includes('Something odd')),
    JSON.stringify(r.parseErrors),
  );
});
