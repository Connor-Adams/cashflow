/**
 * Integration: importWsBundleFile self-heals a mis-typed Wealthsimple account.
 *
 * Background: Account.accountType is locked on first findOrCreate; the
 * InvestmentActivity extraction gate in parseStatementFile keys on
 * accountType==='investment'. A brokerage account that was mis-created as
 * 'checking' (e.g. a filename whose display name didn't match an investment
 * hint) therefore silently drops every BUY/SELL/DIV into the cash path and
 * produces NO InvestmentActivity, corrupting portfolio valuation.
 *
 * Fix under test: when a monthly WS statement carries security-bearing TX
 * codes (BUY/SELL/DIV/CRYPTORWD), the importer upgrades the matched account to
 * 'investment' BEFORE parsing, so the activities are emitted. Pure-cash
 * statements (CONT/INT only — the "Save for Business" HISA class) must NOT
 * trigger the upgrade.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let testDb: PgTestDb;
let householdId: number;
let userId: number;

before(async () => {
  testDb = await setupPgTestDb('wsupgrade');
  const models = await import('../../src/models');
  const { hashPassword } = await import('../../src/auth/password.js');
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `wsupgrade-${Date.now()}@example.com`,
    displayName: 'wsupgrade',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'wsupgrade hh' });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  householdId = household.id;
  userId = user.id;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

async function seedCheckingAccount(shortCode: string, name: string): Promise<number> {
  const models = await import('../../src/models');
  const acct = await models.Account.create({
    householdId,
    ownerUserId: userId,
    owner: 'me',
    visibility: 'shared',
    name,
    accountType: 'checking',
    defaultCurrency: 'CAD',
    shortCode,
  });
  return acct.id;
}

function wsCsv(rows: string[]): Buffer {
  return Buffer.from(
    ['date,transaction,description,amount,balance,currency', ...rows].join('\n'),
    'utf8',
  );
}

test('upgrades a mis-typed checking account to investment when the statement carries a BUY, and emits InvestmentActivity', async () => {
  const models = await import('../../src/models');
  const { importWsBundleFile } = await import('../../src/import/runImport');
  const shortCode = 'HQUPGR001CAD';
  const accountId = await seedCheckingAccount(shortCode, 'Mislabeled brokerage');

  const buffer = wsCsv([
    '2025-01-06,BUY,"XEQT - iShares Core Equity ETF Portfolio: Bought 10.0485 shares (executed at 2025-01-06)",-300.00,0,CAD',
    '2025-01-08,CONT,Contribution (executed at 2025-01-08),300.00,300.00,CAD',
  ]);

  const result = await importWsBundleFile({
    buffer,
    fileName: `Cash-2025-01-31-monthly-statement-transactions-${shortCode}.csv`,
    householdId,
    userId,
  });

  assert.equal(result.accountId, accountId, 'matched the pre-existing account by shortCode');

  const acct = await models.Account.findByPk(accountId);
  assert.equal(acct?.accountType, 'investment', 'accountType upgraded checking → investment');

  const activities = await models.InvestmentActivity.findAll({ where: { accountId } });
  const buys = activities.filter((a) => a.activityType === 'buy');
  assert.ok(buys.length >= 1, 'the BUY row produced an InvestmentActivity');
  assert.ok(buys[0].securityId != null, 'the buy activity resolved a security');
});

test('does NOT upgrade a pure-cash HISA statement (CONT + Interest only)', async () => {
  const models = await import('../../src/models');
  const { importWsBundleFile } = await import('../../src/import/runImport');
  const shortCode = 'WK56CASH01CAD';
  const accountId = await seedCheckingAccount(shortCode, 'Save for Business clone');

  const buffer = wsCsv([
    '2025-02-01,CONT,Contribution (executed at 2025-02-01),100.00,100.00,CAD',
    '2025-02-05,INT,Interest received (executed at 2025-02-05),0.50,100.50,CAD',
  ]);

  await importWsBundleFile({
    buffer,
    fileName: `Save for business-2025-02-28-monthly-statement-transactions-${shortCode}.csv`,
    householdId,
    userId,
  });

  const acct = await models.Account.findByPk(accountId);
  assert.equal(acct?.accountType, 'checking', 'cash-only statement leaves accountType unchanged');

  const activityCount = await models.InvestmentActivity.count({ where: { accountId } });
  assert.equal(activityCount, 0, 'no InvestmentActivity emitted for a still-checking account');
});
