/**
 * Statement-balance capture on commit (sqlite-backed).
 *
 * A statement import persists the statement's own opening/closing balance as
 * an `account_statements` row, so the app's computed balance can be
 * reconciled against the bank's figure. And a statement whose period parsed
 * but whose balance did not must say so on the import record, instead of
 * quietly leaving every balance reader without a statement figure.
 */
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedCashTransaction, StatementPreview, StatementSummary } from './statementTypes';

import * as models from '../models';
import { commitStatementImport } from './commitStatementImport';
import { captureStatementBalance } from './captureStatementBalance';

beforeEach(async () => {
  await models.sequelize.sync({ force: true });
});

after(async () => {
  await models.sequelize.close();
});

async function seedAccount(
  accountType: string,
): Promise<{ householdId: number; accountId: number }> {
  const hh = await models.Household.create({ name: 'Stmt HH' } as never);
  const acc = await models.Account.create({
    name: `Acct ${accountType}`,
    owner: 'me',
    householdId: hh.id,
    defaultCurrency: 'CAD',
    accountType,
    visibility: 'private',
  } as never);
  return { householdId: hh.id as number, accountId: acc.id as number };
}

function row(amount: number, suffix: string): NormalizedCashTransaction {
  return {
    date: '2026-03-15',
    merchantRaw: `ROW ${suffix}`,
    merchantClean: `ROW ${suffix}`,
    amount,
    currency: 'CAD',
    sourceReference: null,
    sourceRowFingerprint: `fp-${suffix}-${Math.random()}`,
  };
}

function makePreview(
  accountId: number,
  householdId: number,
  opts: {
    rows?: NormalizedCashTransaction[];
    summary?: StatementSummary;
    contentHash?: string;
  } = {},
): StatementPreview {
  const nonce = `${Date.now()}-${Math.random()}`;
  return {
    previewToken: `tok-${nonce}`,
    fileName: 'statement.pdf',
    contentHash: opts.contentHash ?? `hash-${nonce}`,
    accountId,
    householdId,
    importBatch: `batch-${nonce}`,
    usedParser: 'pdf',
    transactions: opts.rows ?? [row(-500, nonce)],
    investmentActivities: [],
    holdings: [],
    warnings: [],
    rowErrors: 0,
    parseErrors: [],
    duplicateCounts: { transactions: 0, investmentActivities: 0, holdings: 0 },
    ...(opts.summary ? { statementSummary: opts.summary } : {}),
  };
}

function summary(overrides: Partial<StatementSummary> = {}): StatementSummary {
  return {
    periodStart: '2026-03-04',
    periodEnd: '2026-04-06',
    openingBalance: 4000,
    closingBalance: 4500,
    ...overrides,
  };
}

test('a statement with printed balances writes one account_statements row for its period', async () => {
  const { householdId, accountId } = await seedAccount('loan');
  await commitStatementImport(makePreview(accountId, householdId, { summary: summary() }), null, householdId);

  const rows = await models.AccountStatement.findAll({ where: { accountId } });
  assert.equal(rows.length, 1);
  const s = rows[0];
  assert.equal(s.householdId, householdId);
  assert.equal(s.periodStart, '2026-03-04');
  assert.equal(s.periodEnd, '2026-04-06');
  assert.equal(Number(s.openingBalance), 4000);
  assert.equal(Number(s.closingBalance), 4500);
  assert.equal(s.currency, 'CAD');
  assert.equal(s.sourceFilename, 'statement.pdf');
  assert.equal(s.visibility, 'shared');
});

test('re-importing the same statement period updates the row in place', async () => {
  const { householdId, accountId } = await seedAccount('loan');
  await commitStatementImport(makePreview(accountId, householdId, { summary: summary() }), null, householdId);
  await commitStatementImport(
    makePreview(accountId, householdId, { summary: summary({ closingBalance: 4600 }) }),
    null,
    householdId,
  );
  const rows = await models.AccountStatement.findAll({ where: { accountId } });
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].closingBalance), 4600);
});

test('an already-imported file still backfills its statement balance', async () => {
  const { householdId, accountId } = await seedAccount('loan');
  // First import predates balance capture: no summary on the preview.
  await commitStatementImport(makePreview(accountId, householdId, { contentHash: 'same' }), null, householdId);
  assert.equal(await models.AccountStatement.count({ where: { accountId } }), 0);

  const second = await commitStatementImport(
    makePreview(accountId, householdId, { contentHash: 'same', summary: summary() }),
    null,
    householdId,
  );
  assert.equal(second.insertedTransactions, 0, 'the already-imported short-circuit still holds');
  assert.equal(await models.AccountStatement.count({ where: { accountId } }), 1);
});

test('a statement with no printed opening derives it from the closing balance and the activity', async () => {
  const { householdId, accountId } = await seedAccount('credit_card');
  // Card owes 1,000 at close. A 200 charge and a 50 payment during the period
  // mean it owed 1,000 − 200 + 50 = 850 at open.
  await commitStatementImport(
    makePreview(accountId, householdId, {
      rows: [row(-200, 'charge'), row(50, 'payment')],
      summary: summary({ openingBalance: null, closingBalance: 1000 }),
    }),
    null,
    householdId,
  );
  const s = await models.AccountStatement.findOne({ where: { accountId } });
  assert.ok(s);
  assert.equal(Number(s.openingBalance), 850);
  assert.equal(Number(s.closingBalance), 1000);
  assert.match(s.notes ?? '', /derived/i);
});

test('a credit-card statement whose period parsed but balance did not records a warning on the import', async () => {
  const { householdId, accountId } = await seedAccount('credit_card');
  const result = await commitStatementImport(
    makePreview(accountId, householdId, {
      summary: summary({ openingBalance: null, closingBalance: null }),
    }),
    null,
    householdId,
  );
  assert.equal(await models.AccountStatement.count({ where: { accountId } }), 0);
  assert.ok(
    result.warnings.some((w) => /balance/i.test(w) && w.includes('2026-04-06')),
    `expected a missing-balance warning, got ${JSON.stringify(result.warnings)}`,
  );
  const history = await models.ImportHistory.findOne({ where: { accountId } });
  assert.ok(history);
  assert.equal(history.status, 'success', 'a missing balance warns; it does not fail the import');
  assert.match(history.errorMessage ?? '', /balance/i);
});

test('a chequing statement with no balance is not flagged', async () => {
  const { householdId, accountId } = await seedAccount('checking');
  const result = await commitStatementImport(
    makePreview(accountId, householdId, {
      summary: summary({ openingBalance: null, closingBalance: null }),
    }),
    null,
    householdId,
  );
  assert.equal(result.warnings.filter((w) => /Statement balance/i.test(w)).length, 0);
  const history = await models.ImportHistory.findOne({ where: { accountId } });
  assert.equal(history?.errorMessage ?? null, null);
});

test('captureStatementBalance returns the missing-balance warning and writes nothing', async () => {
  const { householdId, accountId } = await seedAccount('loan');
  const account = await models.Account.findByPk(accountId);
  assert.ok(account);
  const preview = makePreview(accountId, householdId, {
    summary: summary({ openingBalance: null, closingBalance: null }),
  });
  const warnings = await captureStatementBalance(preview, account, null, null);
  assert.equal(warnings.length, 1);
  assert.deepEqual(preview.warnings, warnings);
  assert.equal(await models.AccountStatement.count({ where: { accountId } }), 0);
});

test('captureStatementBalance never moves a statement the user already reconciled', async () => {
  const { householdId, accountId } = await seedAccount('loan');
  const account = await models.Account.findByPk(accountId);
  assert.ok(account);
  await captureStatementBalance(makePreview(accountId, householdId, { summary: summary() }), account, null, null);
  await models.AccountStatement.update({ reconciledAt: new Date() }, { where: { accountId } });
  const warnings = await captureStatementBalance(
    makePreview(accountId, householdId, { summary: summary({ closingBalance: 9999 }) }),
    account,
    null,
    null,
  );
  assert.deepEqual(warnings, []);
  const s = await models.AccountStatement.findOne({ where: { accountId } });
  assert.equal(Number(s?.closingBalance), 4500);
});

test('captureStatementBalance does nothing for a source with no statement period', async () => {
  const { householdId, accountId } = await seedAccount('credit_card');
  const account = await models.Account.findByPk(accountId);
  assert.ok(account);
  const warnings = await captureStatementBalance(makePreview(accountId, householdId), account, null, null);
  assert.deepEqual(warnings, []);
  assert.equal(await models.AccountStatement.count({ where: { accountId } }), 0);
});
