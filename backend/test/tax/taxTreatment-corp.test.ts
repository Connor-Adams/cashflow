import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../src/db';
import { Account, Entity, Household, Transaction } from '../../src/models';
import { buildCorpFacts } from '../../src/tax/builders/buildCorpFacts';

beforeEach(async () => { await sequelize.sync({ force: true }); });

async function seedCorp() {
  const household = await Household.create({ name: 'C' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'corp', legalName: 'Corp',
    jurisdiction: 'CA-ON', fiscalYearEnd: '12-31',
  } as never);
  const account = await Account.create({
    name: 'Corp Chq', householdId: household.id, accountType: 'checking',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  return { household, entity, account };
}

test('classified corp dividend legs feed dividendsPaid with correct kind', async () => {
  const s = await seedCorp();
  await Transaction.create({
    accountId: s.account.id, householdId: s.household.id, entityId: s.entity.id,
    date: '2025-04-01', amount: '-20000.0000', currency: 'CAD',
    merchantRaw: 'OWNER', merchantClean: 'OWNER', taxTreatment: 'eligible_dividend',
    importBatch: 'seed', sourceRowFingerprint: 'fp-c1', sourceIdentityFingerprint: 'sif-c1',
  } as never);
  const facts = await buildCorpFacts(s.entity.id, { startDate: '2025-01-01', endDate: '2025-12-31' });
  assert.equal(facts.dividendsPaid.length, 1);
  assert.equal(facts.dividendsPaid[0].kind, 'eligible');
  assert.equal(facts.dividendsPaid[0].amount.toFixed(2), '20000.00');
});

test('classified corp salary leg feeds salaryPaid', async () => {
  const s = await seedCorp();
  await Transaction.create({
    accountId: s.account.id, householdId: s.household.id, entityId: s.entity.id,
    date: '2025-04-01', amount: '-5000.0000', currency: 'CAD',
    merchantRaw: 'OWNER', merchantClean: 'OWNER', taxTreatment: 'salary',
    importBatch: 'seed', sourceRowFingerprint: 'fp-c2', sourceIdentityFingerprint: 'sif-c2',
  } as never);
  const facts = await buildCorpFacts(s.entity.id, { startDate: '2025-01-01', endDate: '2025-12-31' });
  assert.equal(facts.salaryPaid.toFixed(2), '5000.00');
});

test('classified non-eligible dividend leg feeds dividendsPaid kind non_eligible', async () => {
  const s = await seedCorp();
  await Transaction.create({
    accountId: s.account.id, householdId: s.household.id, entityId: s.entity.id,
    date: '2025-04-01', amount: '-8000.0000', currency: 'CAD',
    merchantRaw: 'OWNER', merchantClean: 'OWNER', taxTreatment: 'non_eligible_dividend',
    importBatch: 'seed', sourceRowFingerprint: 'fp-c3', sourceIdentityFingerprint: 'sif-c3',
  } as never);
  const facts = await buildCorpFacts(s.entity.id, { startDate: '2025-01-01', endDate: '2025-12-31' });
  assert.equal(facts.dividendsPaid.length, 1);
  assert.equal(facts.dividendsPaid[0].kind, 'non_eligible');
  assert.equal(facts.dividendsPaid[0].amount.toFixed(2), '8000.00');
});
