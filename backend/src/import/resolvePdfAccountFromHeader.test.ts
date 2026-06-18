import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let Account: typeof import('../models/Account').Account;
let Entity: typeof import('../models/Entity').Entity;
let Household: typeof import('../models/Household').Household;
let resolvePdfAccountFromHeader: typeof import('./runImport').resolvePdfAccountFromHeader;

before(async () => {
  const models = await import('../models');
  sequelize = models.sequelize;
  Account = models.Account;
  Entity = models.Entity;
  Household = models.Household;
  ({ resolvePdfAccountFromHeader } = await import('./runImport'));
  await sequelize.sync({ force: true });
});

after(async () => {
  await sequelize.close();
});

let householdId: number;
const userId = 1;
beforeEach(async () => {
  await Account.destroy({ where: {}, truncate: true });
  await Entity.destroy({ where: {}, truncate: true });
  await Household.destroy({ where: {}, truncate: true });
  householdId = (await Household.create({ name: 'H' })).id;
});

/** A Wise PDF header for one currency. accountSuffix = last-4 of the Wise account number. */
function wiseHeader(
  currency: string,
  accountSuffix: string,
  accountHolder: string,
): import('./pdf/types').PdfStatementHeader {
  return {
    accountSuffix,
    productLabel: `Wise ${currency}`,
    accountType: 'checking',
    periodStart: '2025-06-01',
    periodEnd: '2025-06-30',
    currency,
    accountHolder,
  };
}

test('corp Wise statement does NOT merge into the same-named personal Wise account', async () => {
  // Personal Wise USD imported first (different account number → suffix 1111).
  const personal = await resolvePdfAccountFromHeader(
    wiseHeader('USD', '1111', 'Connor Adams'),
    householdId,
    userId,
  );
  assert.equal(personal.accountCreated, true);
  assert.equal(personal.overrideBusiness, false);

  // Corp Wise USD imported next: same product/name, different account number
  // (suffix 2222), corp holder. It MUST create a distinct corp account, not
  // collapse into the personal one — keying on name alone merged it before.
  const corp = await resolvePdfAccountFromHeader(
    wiseHeader('USD', '2222', 'CDG Labs Inc.'),
    householdId,
    userId,
  );
  assert.equal(corp.accountCreated, true, 'corp Wise account must be created, not merged');
  assert.notEqual(corp.account.id, personal.account.id, 'corp and personal Wise must be distinct accounts');
  assert.equal(corp.overrideBusiness, true);

  const corpEntity = await Entity.findByPk(corp.account.entityId);
  assert.equal(corpEntity?.kind, 'corp', 'corp account points at the corp entity');

  const wiseUsd = await Account.findAll({ where: { householdId, name: 'Wise USD' } });
  assert.equal(wiseUsd.length, 2, 'two distinct Wise USD accounts: personal + corp');
});

test('personal Wise statement does NOT merge into a pre-existing corp Wise account', async () => {
  // Reverse direction: corp account exists first.
  const corp = await resolvePdfAccountFromHeader(
    wiseHeader('CAD', '2222', 'CDG Labs Inc.'),
    householdId,
    userId,
  );
  assert.equal(corp.overrideBusiness, true);

  const personal = await resolvePdfAccountFromHeader(
    wiseHeader('CAD', '1111', 'Connor Adams'),
    householdId,
    userId,
  );
  assert.equal(personal.accountCreated, true, 'personal Wise account must be created, not merged into corp');
  assert.notEqual(personal.account.id, corp.account.id);
  assert.equal(personal.overrideBusiness, false);

  const personalEntity = await Entity.findByPk(personal.account.entityId);
  assert.equal(personalEntity?.kind, 'personal', 'personal account points at the personal entity');
});

test('re-importing the same personal Wise statement reuses the account (no duplicate)', async () => {
  const first = await resolvePdfAccountFromHeader(
    wiseHeader('EUR', '3333', 'Connor Adams'),
    householdId,
    userId,
  );
  assert.equal(first.accountCreated, true);

  // Same statement again — must find the existing account by shortCode, not fork.
  const again = await resolvePdfAccountFromHeader(
    wiseHeader('EUR', '3333', 'Connor Adams'),
    householdId,
    userId,
  );
  assert.equal(again.accountCreated, false, 're-import must reuse the existing account');
  assert.equal(again.account.id, first.account.id);
  assert.equal((await Account.findAll({ where: { householdId, name: 'Wise EUR' } })).length, 1);
});
