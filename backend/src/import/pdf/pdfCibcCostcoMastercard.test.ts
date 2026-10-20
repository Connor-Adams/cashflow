import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractPdfLines } from './extractLines';
import { parseCibcCostcoHeader, parseCibcCostcoRow, inferYearForMonthDay, cibcCostcoMastercardParser } from './cibcCostcoMastercard';
import { skipUnlessPrivateFixtures } from '../../../test/helpers/privateFixtures';
import type { PdfLine } from './types';
import { synthPdfLines, type SynthPage } from '../../../test/helpers/syntheticPdf';
import { SYN_CIBC_A, SYN_CIBC_B, SYN_CIBC_C, SYN_CIBC_LAST4 } from '../../../test/helpers/syntheticStatements';

// Two kinds of fixture:
//  - SYNTHETIC statements (test/helpers/syntheticStatements.ts): made-up values
//    in the real layout. They always run, including in CI.
//  - PRIVATE statements: Connor's real PDFs, gitignored under
//    backend/test/fixtures/pdf/. LOCAL-ONLY regression checks against the real
//    layout; each has a synthetic twin below. In CI they skip with a loud reason.
const backendRoot = join(__dirname, '..', '..', '..');
const fixturesDir = join(backendRoot, 'test', 'fixtures', 'pdf');
const skipPrivate = (name: string) => skipUnlessPrivateFixtures(join(fixturesDir, name));

async function loadFixture(name: string) {
  const buf = await readFile(join(fixturesDir, name));
  return extractPdfLines(buf);
}

type ExpectedHeader = { statementDate: string; periodStart: string; periodEnd: string; accountLast4: string };
type HeaderCase = { label: string; skip?: string; lines: () => Promise<PdfLine[]>; expected: ExpectedHeader };

const privateHeader = (label: string, file: string, expected: ExpectedHeader): HeaderCase => ({
  label, skip: skipPrivate(file), lines: () => loadFixture(file), expected,
});
const syntheticHeader = (label: string, pages: SynthPage[], expected: Omit<ExpectedHeader, 'accountLast4'>): HeaderCase => ({
  label, lines: async () => synthPdfLines(pages), expected: { ...expected, accountLast4: SYN_CIBC_LAST4 },
});

const HEADER_CASES: HeaderCase[] = [
  privateHeader('January 2026 statement', 'cibc-costco-2026-01-12.pdf', {
    statementDate: '2026-01-12', periodStart: '2025-12-13', periodEnd: '2026-01-12', accountLast4: '3114',
  }),
  privateHeader('December 2025 statement', 'cibc-costco-2025-12-12.pdf', {
    statementDate: '2025-12-12', periodStart: '2025-11-13', periodEnd: '2025-12-12', accountLast4: '3114',
  }),
  privateHeader('November 2025 statement', 'cibc-costco-2025-11-12.pdf', {
    statementDate: '2025-11-12', periodStart: '2025-10-13', periodEnd: '2025-11-12', accountLast4: '3114',
  }),
  syntheticHeader('synthetic rollover statement (fully-qualified period)', SYN_CIBC_C, {
    statementDate: '2024-01-12', periodStart: '2023-12-13', periodEnd: '2024-01-12',
  }),
  syntheticHeader('synthetic statement (date on next line, period from "Transactions from")', SYN_CIBC_B, {
    statementDate: '2024-06-12', periodStart: '2024-05-13', periodEnd: '2024-06-12',
  }),
  syntheticHeader('synthetic statement (abbreviated same-year period)', SYN_CIBC_A, {
    statementDate: '2024-05-12', periodStart: '2024-04-13', periodEnd: '2024-05-12',
  }),
];

for (const c of HEADER_CASES) {
  test(`parseCibcCostcoHeader — ${c.label}`, { skip: c.skip }, async () => {
    assert.deepEqual(parseCibcCostcoHeader(await c.lines()), c.expected);
  });
}

test('parseCibcCostcoHeader — abbreviated period across the year boundary takes the prior year for its start', () => {
  const h = parseCibcCostcoHeader(synthPdfLines([[
    [[0, 'CIBC Costco Mastercard']],
    [[0, 'Statement Date'], [40, 'January 12, 2024']],
    [[0, 'December statement period'], [40, 'December 13 to January 12, 2024']],
    [[0, 'Account number'], [40, `5160 XXXX XXXX ${SYN_CIBC_LAST4}`]],
  ]]));
  assert.equal(h.periodStart, '2023-12-13');
  assert.equal(h.periodEnd, '2024-01-12');
});

test('inferYearForMonthDay picks the period-start year for Nov 23 in a Nov→Dec period', () => {
  const y = inferYearForMonthDay('Nov 23', { start: '2025-11-13', end: '2025-12-12' });
  assert.equal(y, 2025);
});

test('inferYearForMonthDay handles year-rollover periods: Dec 24 in Dec→Jan period is the start year', () => {
  const y = inferYearForMonthDay('Dec 24', { start: '2025-12-13', end: '2026-01-12' });
  assert.equal(y, 2025);
});

test('inferYearForMonthDay handles year-rollover periods: Jan 02 in Dec→Jan period is the end year', () => {
  const y = inferYearForMonthDay('Jan 02', { start: '2025-12-13', end: '2026-01-12' });
  assert.equal(y, 2026);
});

test('inferYearForMonthDay throws when month is outside the period', () => {
  assert.throws(() => inferYearForMonthDay('Jun 15', { start: '2025-12-13', end: '2026-01-12' }));
});

test('parseCibcCostcoRow — payment row dates by TRANSACTION date (col 0), not posting date', () => {
  const period = { start: '2025-12-13', end: '2026-01-12' };
  const row = parseCibcCostcoRow(
    'Dec 24           Dec 29          PAYMENT THANK YOU/PAIEMENT MERCI                                                                                                                                  577.04',
    period,
    'payments',
  );
  assert.deepEqual(row, {
    date: '2025-12-24',
    merchantRaw: 'PAYMENT THANK YOU/PAIEMENT MERCI',
    amount: 577.04,
  });
});

test('parseCibcCostcoRow — charge row with spend category', () => {
  const period = { start: '2025-12-13', end: '2026-01-12' };
  const row = parseCibcCostcoRow(
    'Dec 13           Dec 15            COSTCO WHOLESALE W1168 GUELPH                             ON                          Retail and Grocery                                                        947.04',
    period,
    'charges',
  );
  assert.equal(row.date, '2025-12-13');
  assert.equal(row.merchantRaw, 'COSTCO WHOLESALE W1168 GUELPH ON');
  assert.equal(row.amount, -947.04);
});

test('parseCibcCostcoRow — charge row with bonus Ý prefix is stripped', () => {
  const period = { start: '2025-11-13', end: '2025-12-12' };
  const row = parseCibcCostcoRow(
    'Dec 08           Dec 09      Ý COSTCO GAS W1168                        GUELPH           ON                               Transportation                                                              61.71',
    period,
    'charges',
  );
  assert.equal(row.date, '2025-12-08');
  assert.ok(!row.merchantRaw.includes('Ý'), 'Ý marker should be stripped');
  assert.equal(row.merchantRaw, 'COSTCO GAS W1168 GUELPH ON');
  assert.equal(row.amount, -61.71);
});

test('parseCibcCostcoRow — throws on charge row with too few columns (collapsed gap)', () => {
  const period = { start: '2025-12-13', end: '2026-01-12' };
  // 4 cols instead of 5 — merchant+category collapsed
  assert.throws(
    () => parseCibcCostcoRow(
      'Dec 13   Dec 15   COSTCO WHOLESALE   947.04',
      period,
      'charges',
    ),
    /too few columns|empty merchant/,
  );
});

test('parseCibcCostcoRow — CR suffix on a charge row flips sign to credit', () => {
  const period = { start: '2025-12-13', end: '2026-01-12' };
  const row = parseCibcCostcoRow(
    'Dec 20   Dec 21   COSTCO REFUND W1168 GUELPH   ON   Retail and Grocery   125.00 CR',
    period,
    'charges',
  );
  assert.equal(row.date, '2025-12-20');
  assert.equal(row.merchantRaw, 'COSTCO REFUND W1168 GUELPH ON');
  assert.equal(row.amount, 125);  // positive because CR flipped the default-negative
});

test('parseCibcCostcoRow — interest row', () => {
  const period = { start: '2025-10-13', end: '2025-11-12' };
  const row = parseCibcCostcoRow(
    'Nov 12           Nov 12          REGULAR PURCHASES                                                                     21.75%                                                                          0.07',
    period,
    'interest',
  );
  assert.equal(row.date, '2025-11-12');
  assert.equal(row.merchantRaw, 'REGULAR PURCHASES');
  assert.equal(row.amount, -0.07);
});

test('parser end-to-end — November 2025 statement (3 sub-sections present)', { skip: skipPrivate('cibc-costco-2025-11-12.pdf') }, async () => {
  const lines = await loadFixture('cibc-costco-2025-11-12.pdf');
  const out = cibcCostcoMastercardParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(out.transactions.length, 3);

  const byDate = [...out.transactions].sort((a, b) => a.date.localeCompare(b.date));
  assert.equal(byDate[0].date, '2025-10-24');
  assert.equal(byDate[0].amount, -3.15);
  assert.ok(byDate[0].merchantRaw.includes('Google One'));

  const payment = out.transactions.find((t) => t.merchantRaw.includes('PAYMENT THANK YOU'));
  assert.ok(payment);
  assert.equal(payment!.amount, 10);

  const interest = out.transactions.find((t) => t.merchantRaw === 'REGULAR PURCHASES');
  assert.ok(interest);
  assert.equal(interest!.amount, -0.07);

  assert.ok(out.transactions.every((t) => t.currency === 'CAD'));
  assert.deepEqual(out.parseErrors, []);
});

test('parser end-to-end — December 2025 statement (payments empty, charges present)', { skip: skipPrivate('cibc-costco-2025-12-12.pdf') }, async () => {
  const lines = await loadFixture('cibc-costco-2025-12-12.pdf');
  const out = cibcCostcoMastercardParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(out.transactions.length, 5);
  const total = out.transactions.reduce((s, t) => s + t.amount, 0);
  assert.equal(Math.round(total * 100) / 100, -580.67);
});

test('parser end-to-end — January 2026 statement (rollover period, payment + 5 charges)', { skip: skipPrivate('cibc-costco-2026-01-12.pdf') }, async () => {
  const lines = await loadFixture('cibc-costco-2026-01-12.pdf');
  const out = cibcCostcoMastercardParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(out.transactions.length, 6);

  const payment = out.transactions.find((t) => t.merchantRaw.includes('PAYMENT THANK YOU'));
  // Dates by transaction date (col 0 = Dec 24), not posting date (Dec 29).
  assert.equal(payment?.date, '2025-12-24');
  assert.equal(payment?.amount, 577.04);

  const renewal = out.transactions.find((t) => t.merchantRaw.includes('ANNUAL RENEWAL'));
  assert.equal(renewal?.date, '2026-01-02');
  assert.equal(renewal?.amount, -146.90);

  const chargeSum = out.transactions
    .filter((t) => t.amount < 0)
    .reduce((s, t) => s + t.amount, 0);
  assert.equal(Math.round(chargeSum * 100) / 100, -2278);
});

// ─── Synthetic twins of the private end-to-end tests above ───────────────────

const parseSynthetic = (pages: SynthPage[]) =>
  cibcCostcoMastercardParser.parse(synthPdfLines(pages), { defaultCurrency: 'CAD' });

test('parser end-to-end — synthetic statement with all 3 sub-sections', () => {
  const out = parseSynthetic(SYN_CIBC_A);
  assert.deepEqual(out.parseErrors, []);
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(
    [...out.transactions]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((t) => ({ date: t.date, merchantRaw: t.merchantRaw, amount: t.amount, currency: t.currency })),
    [
      { date: '2024-04-24', merchantRaw: 'SAMPLE CLOUD STORAGE ANYTOWN ON', amount: -4.99, currency: 'CAD' },
      { date: '2024-04-28', merchantRaw: 'PAYMENT THANK YOU/PAIEMENT MERCI', amount: 25, currency: 'CAD' },
      { date: '2024-05-12', merchantRaw: 'REGULAR PURCHASES', amount: -0.42, currency: 'CAD' },
    ],
  );
});

test('parser end-to-end — synthetic statement (payments empty, 5 charges incl. a bonus-rewards row)', () => {
  const out = parseSynthetic(SYN_CIBC_B);
  assert.deepEqual(out.parseErrors, []);
  assert.deepEqual(out.warnings, []);
  assert.equal(out.transactions.length, 5);
  const total = out.transactions.reduce((s, t) => s + t.amount, 0);
  assert.equal(Math.round(total * 100) / 100, -412.37);
  // The Ý bonus-rewards marker is stripped from the merchant.
  const gas = out.transactions.find((t) => t.merchantRaw.includes('COSTCO GAS'));
  assert.equal(gas?.merchantRaw, 'COSTCO GAS W0001 ANYTOWN ON');
  assert.equal(gas?.amount, -58.1);
});

test('parser end-to-end — synthetic rollover statement (payment + 5 charges, dated by transaction date)', () => {
  const out = parseSynthetic(SYN_CIBC_C);
  assert.deepEqual(out.parseErrors, []);
  assert.deepEqual(out.warnings, []);
  assert.equal(out.transactions.length, 6);

  const payment = out.transactions.find((t) => t.merchantRaw.includes('PAYMENT THANK YOU'));
  // Dates by transaction date (col 0 = Dec 22), not posting date (Dec 27).
  assert.equal(payment?.date, '2023-12-22');
  assert.equal(payment?.amount, 300);

  // Dec 30 charge posted Jan 02 stays in the start year; Jan rows take the end year.
  const transit = out.transactions.find((t) => t.merchantRaw.includes('SAMPLE TRANSIT'));
  assert.equal(transit?.date, '2023-12-30');
  const renewal = out.transactions.find((t) => t.merchantRaw.includes('ANNUAL RENEWAL'));
  assert.equal(renewal?.date, '2024-01-02');
  assert.equal(renewal?.amount, -120);

  const chargeSum = out.transactions.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0);
  assert.equal(Math.round(chargeSum * 100) / 100, -1500);
});

test('parser produces a deterministic merchantClean — synthetic statement', () => {
  const out = parseSynthetic(SYN_CIBC_B);
  const costco = out.transactions.find((t) => t.merchantRaw.includes('COSTCO WHOLESALE'));
  assert.ok(costco);
  assert.ok(!/\s{2,}/.test(costco.merchantRaw));
  assert.equal(costco.merchantRaw, 'COSTCO WHOLESALE W0001 ANYTOWN ON');
  assert.ok(typeof costco.merchantClean === 'string' && costco.merchantClean.length > 0);
  // Same input, same output.
  const again = parseSynthetic(SYN_CIBC_B).transactions.find((t) => t.merchantRaw === costco.merchantRaw);
  assert.equal(again?.merchantClean, costco.merchantClean);
});

// ─── Section sum cross-check (synthetic lines, no fixtures needed) ────────────
//
// The printed "Total for …" of "Your new charges and credits" is NET of
// credits, so the parsed sum must accumulate signed amounts in the statement's
// own convention (charges positive, CR credits negative) — an absolute-value
// sum both false-alarms on any CR credit and can never catch a sign flip.


function mkSyn(text: string, page = 1): PdfLine {
  return { page, y: 0, text, items: [{ x: 18, width: text.length * 5, str: text }] };
}

const SYN_HEADER: PdfLine[] = [
  mkSyn('CIBC Costco Mastercard'),
  mkSyn('Statement Date January 12, 2026'),
  mkSyn('December statement period December 13, 2025 to January 12, 2026'),
  mkSyn('5160 XXXX XXXX 3114'),
];

test('section cross-check does not false-alarm on a CR credit against the NET printed total', () => {
  const lines = [
    ...SYN_HEADER,
    mkSyn('Your new charges and credits', 2),
    mkSyn('Dec 13   Dec 15   COSTCO WHOLESALE W1168 GUELPH   ON   Retail and Grocery   1,000.00', 2),
    mkSyn('Dec 20   Dec 21   COSTCO REFUND W1168 GUELPH   ON   Retail and Grocery   125.00 CR', 2),
    mkSyn('Total for 5160 XXXX XXXX 3114   $875.00', 2),
  ];
  const out = cibcCostcoMastercardParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.deepEqual(out.parseErrors, []);
  assert.deepEqual(
    out.transactions.map((t) => t.amount).sort((a, b) => a - b),
    [-1000, 125],
  );
  assert.deepEqual(out.warnings, []);
});

test('section cross-check still fires on a genuine mismatch', () => {
  const lines = [
    ...SYN_HEADER,
    mkSyn('Your new charges and credits', 2),
    mkSyn('Dec 13   Dec 15   COSTCO WHOLESALE W1168 GUELPH   ON   Retail and Grocery   1,000.00', 2),
    mkSyn('Total for 5160 XXXX XXXX 3114   $1,500.00', 2),
  ];
  const out = cibcCostcoMastercardParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(out.warnings.length, 1);
  assert.ok(out.warnings[0].includes('sum mismatch'));
});

test('payments section reconciles against its printed total in the statement convention', () => {
  const lines = [
    ...SYN_HEADER,
    mkSyn('Your payments', 2),
    mkSyn('Dec 24           Dec 29          PAYMENT THANK YOU/PAIEMENT MERCI            577.04', 2),
    mkSyn('Total payments   $577.04', 2),
  ];
  const out = cibcCostcoMastercardParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(out.transactions.length, 1);
  assert.equal(out.transactions[0].amount, 577.04);
  assert.deepEqual(out.warnings, []);
});

test('parser produces a deterministic merchantClean (uppercased, collapsed whitespace, no trailing province)', { skip: skipPrivate('cibc-costco-2025-12-12.pdf') }, async () => {
  const lines = await loadFixture('cibc-costco-2025-12-12.pdf');
  const out = cibcCostcoMastercardParser.parse(lines, { defaultCurrency: 'CAD' });
  const costco = out.transactions.find((t) => t.merchantRaw.includes('COSTCO WHOLESALE'));
  assert.ok(costco);
  assert.ok(!/\s{2,}/.test(costco!.merchantRaw));
  assert.ok(typeof costco!.merchantClean === 'string' && costco!.merchantClean.length > 0);
});

// ─── Header contract (synthetic lines, no fixtures needed) ────────────────────
//
// Both bundle entry points (runImport.ts pdfBundle* and the async
// pdfImportProcessor worker) hard-require `parseOut.header` to resolve the
// account, and throw "produced no header for account match" without it. This
// parser predates that contract by one day (parser 2026-05-23, contract
// b6df539f 2026-05-24) and `PdfParseResult.header` is optional, so the omission
// compiled fine and silently failed every CIBC import from then on.

test('parse() returns a PdfStatementHeader — bundle/processor account match needs it', () => {
  const out = cibcCostcoMastercardParser.parse(
    [
      ...SYN_HEADER,
      mkSyn('Your payments', 2),
      mkSyn('Dec 24           Dec 29          PAYMENT THANK YOU/PAIEMENT MERCI            577.04', 2),
      mkSyn('Total payments   $577.04', 2),
    ],
    { defaultCurrency: 'CAD' },
  );
  assert.ok(out.header, 'parser must return a header or every bundle import throws');
  assert.equal(out.header.accountSuffix, '3114');
  assert.equal(out.header.productLabel, 'CIBC Costco Mastercard');
  assert.equal(out.header.accountType, 'credit_card');
  assert.equal(out.header.periodStart, '2025-12-13');
  assert.equal(out.header.periodEnd, '2026-01-12');
});
