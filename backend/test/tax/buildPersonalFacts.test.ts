import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../src/db';
import {
  Account, Entity, FxRate, InvestmentActivity, Security, TaxSlip, Transaction,
  Carryforward, Household,
} from '../../src/models';
import { D } from '../../src/tax/util/decimal';
import { buildPersonalFacts } from '../../src/tax/builders/buildPersonalFacts';

before(async () => {
  await sequelize.sync({ force: true });
});

test('builds facts from seeded data', async () => {
  const household = await Household.create({ name: 'Test' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'Personal', jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Checking', householdId: household.id, accountType: 'checking',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2024-03-15', amount: '5000.0000', currency: 'CAD',
    finalCategory: 'employment_income',
    merchantRaw: 'EMPLOYER', merchantClean: 'EMPLOYER',
    importBatch: 'test-seed', sourceRowFingerprint: 'fp-t17-001',
    sourceIdentityFingerprint: 'sif-t17-001',
  } as never);
  const facts = await buildPersonalFacts(entity.id, 2024);
  assert.equal(facts.year, 2024);
  assert.equal(facts.jurisdiction, 'CA-ON');
  assert.equal(facts.employmentIncome.length, 1, 'seeded employment txn should appear');
  assert.equal(facts.employmentIncome[0].cadAmount.toFixed(2), '5000.00');
});

test('USD interest converted to CAD via FxRate', async () => {
  // Engineer: seed Security + InvestmentActivity in USD + FxRate USD->CAD = 1.35
  // then assert interestIncome[0].cadAmount = amount * 1.35
});
