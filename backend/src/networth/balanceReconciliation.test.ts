/**
 * Balance reconciliation: the app's computed balance at each statement's
 * period end vs the statement's own closing balance, plus accounts whose
 * opening balance has no anchor date.
 *
 * The motivating bug: the RBC Royal Credit Line carried an opening balance of
 * −13,654.86 with no opening_balance_date. balanceAtDate treats that as a
 * balance before all history, so the line showed $36,354 owed against a real
 * $22,700 — and nothing compared the two.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

let models: typeof import('../models/index.js');
let checkBalanceIntegrity: typeof import('./balanceReconciliation.js').checkBalanceIntegrity;

before(async () => {
  models = await import('../models/index.js');
  await models.sequelize.sync({ force: true });
  checkBalanceIntegrity = (await import('./balanceReconciliation.js')).checkBalanceIntegrity;
});

beforeEach(async () => {
  await models.sequelize.sync({ force: true });
});

after(async () => {
  await models.sequelize.close();
});

let householdId = 0;

async function seedHousehold(): Promise<number> {
  const hh = await models.Household.create({ name: 'Recon HH' } as never);
  householdId = hh.id as number;
  return householdId;
}

async function seedAccount(opts: {
  name?: string;
  accountType?: string;
  openingBalance?: number;
  openingBalanceDate?: string | null;
}) {
  return models.Account.create({
    name: opts.name ?? 'Acct',
    owner: 'me',
    householdId,
    visibility: 'shared',
    accountType: opts.accountType ?? 'checking',
    defaultCurrency: 'CAD',
    openingBalance: String(opts.openingBalance ?? 0),
    openingBalanceDate: opts.openingBalanceDate ?? null,
  } as never);
}

let n = 0;
async function seedTxn(accountId: number, date: string, amount: number) {
  n += 1;
  const fp = `recon-${accountId}-${n}-${Math.random()}`;
  await models.Transaction.create({
    accountId,
    householdId,
    date,
    amount: String(amount),
    currency: 'CAD',
    merchantRaw: 't',
    merchantClean: 't',
    importBatch: 'test',
    sourceRowFingerprint: fp,
    sourceIdentityFingerprint: fp,
  } as never);
}

async function seedStatement(accountId: number, periodEnd: string, closing: number) {
  return models.AccountStatement.create({
    householdId,
    accountId,
    createdByUserId: null,
    periodStart: `${periodEnd.slice(0, 8)}01`,
    periodEnd,
    openingBalance: '0',
    closingBalance: String(closing),
    currency: 'CAD',
    sourceFilename: null,
    notes: null,
    reconciledAt: null,
    varianceExplanation: null,
  } as never);
}

function scopes() {
  return { accountScope: { householdId }, statementScope: { householdId } };
}

test('a liability whose undated opening balance inflates the amount owed is reported as a mismatch', async () => {
  await seedHousehold();
  const line = await seedAccount({
    name: 'RBC Royal Credit Line',
    accountType: 'loan',
    openingBalance: -13654.86,
    openingBalanceDate: null,
  });
  // The full history is imported: 22,700 drawn in total.
  await seedTxn(line.id, '2025-08-11', -10000);
  await seedTxn(line.id, '2026-01-11', -12700);
  // The bank says 22,700 owed (positive — liability convention).
  await seedStatement(line.id, '2026-09-03', 22700);

  const result = await checkBalanceIntegrity(scopes());
  assert.equal(result.statementsChecked, 1);
  assert.equal(result.statementMismatches.length, 1);
  const m = result.statementMismatches[0];
  assert.equal(m.accountId, line.id);
  assert.equal(m.accountName, 'RBC Royal Credit Line');
  assert.equal(m.statementDate, '2026-09-03');
  assert.equal(m.currency, 'CAD');
  assert.equal(m.computedBalance, 36354.86);
  assert.equal(m.statementBalance, 22700);
  assert.equal(m.delta, 13654.86);
});

test('the same account is flagged for its undated opening balance', async () => {
  await seedHousehold();
  const line = await seedAccount({ accountType: 'loan', openingBalance: -13654.86, openingBalanceDate: null });
  const result = await checkBalanceIntegrity(scopes());
  assert.deepEqual(result.undatedOpeningBalances, [
    {
      accountId: line.id,
      accountName: 'Acct',
      openingBalance: -13654.86,
      currency: 'CAD',
    },
  ]);
});

test('a statement that agrees with the computed balance is not a mismatch', async () => {
  await seedHousehold();
  const chq = await seedAccount({ openingBalance: 100, openingBalanceDate: '2026-01-01' });
  await seedTxn(chq.id, '2026-02-10', 50.25);
  await seedTxn(chq.id, '2026-03-10', -10); // after the statement: excluded
  await seedStatement(chq.id, '2026-02-28', 150.25);
  const result = await checkBalanceIntegrity(scopes());
  assert.equal(result.statementsChecked, 1);
  assert.deepEqual(result.statementMismatches, []);
});

test('a zero opening balance with no date, or a dated one, is not flagged', async () => {
  await seedHousehold();
  await seedAccount({ openingBalance: 0, openingBalanceDate: null });
  await seedAccount({ openingBalance: 500, openingBalanceDate: '2026-01-01' });
  const result = await checkBalanceIntegrity(scopes());
  assert.deepEqual(result.undatedOpeningBalances, []);
});

test('investment accounts are not reconciled from the transaction stream', async () => {
  await seedHousehold();
  const inv = await seedAccount({ accountType: 'investment' });
  await seedStatement(inv.id, '2026-02-28', 9999);
  const result = await checkBalanceIntegrity(scopes());
  assert.equal(result.statementsChecked, 0);
  assert.deepEqual(result.statementMismatches, []);
});

test('accounts and statements outside the scope are ignored', async () => {
  await seedHousehold();
  const other = await seedAccount({ accountType: 'loan', openingBalance: -5, openingBalanceDate: null });
  await seedStatement(other.id, '2026-02-28', 9999);
  const mine = await seedHousehold();
  const result = await checkBalanceIntegrity({
    accountScope: { householdId: mine },
    statementScope: { householdId: mine },
  });
  assert.equal(result.statementsChecked, 0);
  assert.deepEqual(result.undatedOpeningBalances, []);
});
