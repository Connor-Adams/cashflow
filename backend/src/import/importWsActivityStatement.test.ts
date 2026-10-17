/**
 * The Custom Activity Statement covers every account in one file, where the
 * rest of the import surface resolves one account per file. What matters here
 * is that a single upload can PARTLY succeed: an account the household does
 * not have is reported while its siblings import.
 *
 * Takes already-extracted lines, so these exercise the real splitting and
 * committing without needing a binary PDF fixture. Line shapes are copied
 * verbatim from ACTIVITY_STATEMENT_2026-06-02_2026-09-03.pdf.
 */
import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PdfLine } from './pdf/types';

let models: typeof import('../models/index.js');
let importWsActivityStatement: typeof import('./importWsActivityStatement.js').importWsActivityStatement;
let household: { id: number };
let tfsaId: number;

function mk(...spans: [number, string][]): PdfLine {
  return {
    page: 1,
    y: 0,
    text: spans.map(([, str]) => str).join(' '),
    items: spans.map(([x, str]) => ({ x, width: str.length * 5, str })),
  };
}

function statementLines(): PdfLine[] {
  return [
    mk([43, 'Custom Activity Statement']),
    mk([43, 'TFSA (HQ6LMLTK8CAD)']),
    mk([51, 'Transaction'], [112, 'Settlement']),
    mk([172, 'Transaction Description Debit Credit Currency']),
    mk([51, '2026-06-12 INTEREST Stock lending monthly interest payment $0.01 CAD']),
    mk([250, 'XEQT - iShares Core Equity ETF Portfolio: Cash']),
    mk([51, '2026-06-30 DIVIDEND'], [250, 'dividend distribution, received on 2026-06-30,'], [478, '$26.89 CAD']),
    mk([43, 'Non-registered margin (HQ4TLFJ02CAD)']),
    mk([43, 'No activities were recorded for this account during the specified period.']),
  ];
}

before(async () => {
  models = await import('../models/index.js');
  await models.sequelize.sync({ force: true });
  importWsActivityStatement = (await import('./importWsActivityStatement.js')).importWsActivityStatement;
});

beforeEach(async () => {
  await models.sequelize.sync({ force: true });
  const created = await models.Household.create({ name: 'Activity HH' });
  household = { id: created.id };
  const tfsa = await models.Account.create({
    name: 'WS TFSA', householdId: created.id, accountType: 'investment',
    owner: 'me', visibility: 'private', defaultCurrency: 'CAD', shortCode: 'HQ6LMLTK8CAD',
  } as never);
  tfsaId = tfsa.id as number;
});

const run = () =>
  importWsActivityStatement({
    lines: statementLines(),
    fileName: 'ACTIVITY_STATEMENT_2026-06-02_2026-09-03.pdf',
    contentHash: 'fixed-hash',
    householdId: household.id,
    userId: 1,
  });

test('activities land on the account each section names', async () => {
  const result = await run();
  assert.deepEqual(result.parseErrors, []);
  const tfsa = result.accounts.find((a) => a.wsid === 'HQ6LMLTK8CAD');
  assert.equal(tfsa?.accountId, tfsaId);
  assert.equal(tfsa?.insertedActivities, 2);
  assert.equal(await models.InvestmentActivity.count(), 2);
});

test('an account the household does not have is reported, not invented', async () => {
  const result = await run();
  const orphan = result.accounts.find((a) => a.wsid === 'HQ4TLFJ02CAD');
  assert.equal(orphan?.unmatched, true);
  assert.equal(orphan?.accountId, null);
  assert.equal(orphan?.insertedActivities, 0);
  assert.equal(await models.Account.count(), 1, 'no account was created');
});

test('re-importing the same statement inserts nothing the second time', async () => {
  await run();
  const second = await run();
  assert.equal(second.accounts.find((a) => a.wsid === 'HQ6LMLTK8CAD')?.insertedActivities, 0);
  assert.equal(await models.InvestmentActivity.count(), 2);
});

test('an empty section reports the account without importing anything', async () => {
  // "No activities were recorded…" is a real section, not a parse failure.
  await models.Account.create({
    name: 'WS Margin', householdId: household.id, accountType: 'investment',
    owner: 'me', visibility: 'private', defaultCurrency: 'CAD', shortCode: 'HQ4TLFJ02CAD',
  } as never);
  const result = await run();
  const margin = result.accounts.find((a) => a.wsid === 'HQ4TLFJ02CAD');
  assert.equal(margin?.unmatched, undefined);
  assert.equal(margin?.insertedActivities, 0);
});

// The activity statement is the ONGOING Wealthsimple brokerage ingest path — the
// one that hardcoded `transactions: []` and so lost a $15,000 owner draw. A cash
// crossing here must produce its cash leg too, or every new statement re-creates
// the hole the converter exists to clean up.
test('a transfer_out emits a cash leg as well as the activity', async () => {
  const lines: PdfLine[] = [
    mk([43, 'Custom Activity Statement']),
    mk([43, 'TFSA (HQ6LMLTK8CAD)']),
    mk([51, 'Transaction'], [112, 'Settlement']),
    mk([172, 'Transaction Description Debit Credit Currency']),
    mk([51, '2026-01-10 TRFOUT Money transfer out of the account $15,000.00 CAD']),
  ];
  const result = await importWsActivityStatement({
    lines,
    fileName: 'ACTIVITY_STATEMENT_2026-01-01_2026-01-31.pdf',
    contentHash: 'transfer-out-hash',
    householdId: household.id,
    userId: 1,
  });
  assert.deepEqual(result.parseErrors, []);
  assert.equal(await models.InvestmentActivity.count({ where: { accountId: tfsaId } }), 1);
  assert.equal(
    await models.Transaction.count({ where: { accountId: tfsaId } }),
    1,
    'the cash leg must exist, or the tax engine never sees the movement',
  );
});
