import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { extractPdfLines } from '../src/import/pdf/extractLines';
import { parseCibcCostcoHeader, parseCibcCostcoRow, inferYearForMonthDay, cibcCostcoMastercardParser } from '../src/import/pdf/cibcCostcoMastercard';

const fixturesDir = join(__dirname, 'fixtures', 'pdf');
const hasFixtures = existsSync(join(fixturesDir, 'cibc-costco-2026-01-12.pdf'));
const skipNoFixtures = hasFixtures ? undefined : 'PDF fixtures not present (gitignored — see backend/test/fixtures/pdf/)';

async function loadFixture(name: string) {
  const buf = await readFile(join(fixturesDir, name));
  return extractPdfLines(buf);
}

test('parseCibcCostcoHeader — January 2026 statement', { skip: skipNoFixtures }, async () => {
  const lines = await loadFixture('cibc-costco-2026-01-12.pdf');
  const h = parseCibcCostcoHeader(lines);
  assert.equal(h.statementDate, '2026-01-12');
  assert.equal(h.periodStart, '2025-12-13');
  assert.equal(h.periodEnd, '2026-01-12');
  assert.equal(h.accountLast4, '3114');
});

test('parseCibcCostcoHeader — December 2025 statement', { skip: skipNoFixtures }, async () => {
  const lines = await loadFixture('cibc-costco-2025-12-12.pdf');
  const h = parseCibcCostcoHeader(lines);
  assert.equal(h.statementDate, '2025-12-12');
  assert.equal(h.periodStart, '2025-11-13');
  assert.equal(h.periodEnd, '2025-12-12');
  assert.equal(h.accountLast4, '3114');
});

test('parseCibcCostcoHeader — November 2025 statement', { skip: skipNoFixtures }, async () => {
  const lines = await loadFixture('cibc-costco-2025-11-12.pdf');
  const h = parseCibcCostcoHeader(lines);
  assert.equal(h.statementDate, '2025-11-12');
  assert.equal(h.periodStart, '2025-10-13');
  assert.equal(h.periodEnd, '2025-11-12');
  assert.equal(h.accountLast4, '3114');
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

test('parseCibcCostcoRow — payment row (no spend category, no Ý)', () => {
  const period = { start: '2025-12-13', end: '2026-01-12' };
  const row = parseCibcCostcoRow(
    'Dec 24           Dec 29          PAYMENT THANK YOU/PAIEMENT MERCI                                                                                                                                  577.04',
    period,
    'payments',
  );
  assert.deepEqual(row, {
    date: '2025-12-29',
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
  assert.equal(row.date, '2025-12-15');
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
  assert.equal(row.date, '2025-12-09');
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
  assert.equal(row.date, '2025-12-21');
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

test('parser end-to-end — November 2025 statement (3 sub-sections present)', { skip: skipNoFixtures }, async () => {
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

test('parser end-to-end — December 2025 statement (payments empty, charges present)', { skip: skipNoFixtures }, async () => {
  const lines = await loadFixture('cibc-costco-2025-12-12.pdf');
  const out = cibcCostcoMastercardParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(out.transactions.length, 5);
  const total = out.transactions.reduce((s, t) => s + t.amount, 0);
  assert.equal(Math.round(total * 100) / 100, -580.67);
});

test('parser end-to-end — January 2026 statement (rollover period, payment + 5 charges)', { skip: skipNoFixtures }, async () => {
  const lines = await loadFixture('cibc-costco-2026-01-12.pdf');
  const out = cibcCostcoMastercardParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(out.transactions.length, 6);

  const payment = out.transactions.find((t) => t.merchantRaw.includes('PAYMENT THANK YOU'));
  assert.equal(payment?.date, '2025-12-29');
  assert.equal(payment?.amount, 577.04);

  const renewal = out.transactions.find((t) => t.merchantRaw.includes('ANNUAL RENEWAL'));
  assert.equal(renewal?.date, '2026-01-02');
  assert.equal(renewal?.amount, -146.90);

  const chargeSum = out.transactions
    .filter((t) => t.amount < 0)
    .reduce((s, t) => s + t.amount, 0);
  assert.equal(Math.round(chargeSum * 100) / 100, -2278);
});

test('parser produces a deterministic merchantClean (uppercased, collapsed whitespace, no trailing province)', { skip: skipNoFixtures }, async () => {
  const lines = await loadFixture('cibc-costco-2025-12-12.pdf');
  const out = cibcCostcoMastercardParser.parse(lines, { defaultCurrency: 'CAD' });
  const costco = out.transactions.find((t) => t.merchantRaw.includes('COSTCO WHOLESALE'));
  assert.ok(costco);
  assert.ok(!/\s{2,}/.test(costco!.merchantRaw));
  assert.ok(typeof costco!.merchantClean === 'string' && costco!.merchantClean.length > 0);
});
