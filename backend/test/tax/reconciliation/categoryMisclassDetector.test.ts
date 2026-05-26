import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../../src/db';
import {
  Account, Entity, Household, InvestmentActivity, Security,
} from '../../../src/models';
import { detectCategoryMisclass } from '../../../src/tax/reconciliation/categoryMisclassDetector';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

async function seed() {
  const household = await Household.create({ name: 'T' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Inv', householdId: household.id, accountType: 'investment',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  return { entity, account, household };
}

test('flags dividend activity whose Security has unknown eligibility', async () => {
  const { entity, account, household } = await seed();
  const security = await Security.create({
    symbol: 'FOO', name: 'Foo Corp', currency: 'CAD', householdId: household.id,
    dividendEligibility: 'unknown',
  } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: security.id,
    activityType: 'dividend', tradeDate: '2024-04-15',
    quantity: null, amount: '100', currency: 'CAD', fees: null,
    description: 'FOO dividend', sourceRowFingerprint: 'fp-foo-1', importBatch: 'b',
  } as never);

  const findings = await detectCategoryMisclass(entity.id, 2024);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, 'category_misclass');
  assert.equal(findings[0].severity, 'info');
  assert.match(findings[0].message, /unknown/i);
  assert.match(findings[0].subjectRef, /FOO/);
});

test('no finding when Security has explicit eligible/non_eligible setting', async () => {
  const { entity, account, household } = await seed();
  const security = await Security.create({
    symbol: 'BAR', name: 'Bar Corp', currency: 'CAD', householdId: household.id,
    dividendEligibility: 'eligible',
  } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: security.id,
    activityType: 'dividend', tradeDate: '2024-04-15',
    quantity: null, amount: '100', currency: 'CAD', fees: null,
    description: 'BAR dividend', sourceRowFingerprint: 'fp-bar-1', importBatch: 'b',
  } as never);

  const findings = await detectCategoryMisclass(entity.id, 2024);
  assert.equal(findings.length, 0);
});

test('ignores non-dividend activity types', async () => {
  const { entity, account, household } = await seed();
  const security = await Security.create({
    symbol: 'BAZ', name: 'Baz', currency: 'CAD', householdId: household.id,
    dividendEligibility: 'unknown',
  } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: security.id,
    activityType: 'interest', tradeDate: '2024-04-15',
    quantity: null, amount: '100', currency: 'CAD', fees: null,
    description: 'BAZ interest', sourceRowFingerprint: 'fp-baz-1', importBatch: 'b',
  } as never);

  const findings = await detectCategoryMisclass(entity.id, 2024);
  assert.equal(findings.length, 0);
});
