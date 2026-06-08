import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Account, Entity, Household, InvestmentActivity } from '../models';
import { buildPersonalFacts } from './builders/buildPersonalFacts';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

async function seedInterest(accountId: number, householdId: number, fp: string) {
  await InvestmentActivity.create(
    {
      accountId, householdId, activityType: 'interest', tradeDate: '2024-05-01',
      description: 'Interest', amount: '100.0000', currency: 'CAD',
      sourceRowFingerprint: fp, importBatch: 't',
    } as never,
  );
}

test('registered-account in-account interest is excluded from T1; non_registered is included', async () => {
  const hh = await Household.create({ name: 'H' });
  const personal = await Entity.create(
    { householdId: hh.id, kind: 'personal', legalName: 'Personal', jurisdiction: 'CA-ON', fiscalYearEnd: null } as never,
  );
  const fhsa = await Account.create(
    { name: 'Individual FHSA', householdId: hh.id, accountType: 'investment', entityId: personal.id, taxStatus: 'registered_fhsa' } as never,
  );
  const margin = await Account.create(
    { name: 'Individual Margin', householdId: hh.id, accountType: 'investment', entityId: personal.id, taxStatus: 'non_registered' } as never,
  );
  await seedInterest(fhsa.id, hh.id, 'fp-fhsa');
  await seedInterest(margin.id, hh.id, 'fp-margin');

  const facts = await buildPersonalFacts(personal.id, 2024);
  const total = facts.interestIncome.reduce((sum, item) => sum + Number(item.cadAmount), 0);
  assert.equal(total, 100, 'only the non_registered (Margin) interest should reach T1');
});
