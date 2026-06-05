import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Account, Entity, Household, Transaction } from '../models';
import { buildPersonalFacts } from './builders/buildPersonalFacts';

async function seedPersonal() {
  const household = await Household.create({ name: 'TT' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  } as never);
  const account = await Account.create({
    name: 'Chq', householdId: household.id, accountType: 'checking',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  return { household, entity, account };
}

beforeEach(async () => { await sequelize.sync({ force: true }); });

test('taxTreatmentOverride persists on a Transaction', async () => {
  const { household, entity, account } = await seedPersonal();
  const txn = await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2025-06-15', amount: '1000.0000', currency: 'CAD',
    merchantRaw: 'CORP', merchantClean: 'CORP', taxTreatmentOverride: 'salary',
    importBatch: 'seed', sourceRowFingerprint: 'fp-tt-1', sourceIdentityFingerprint: 'sif-tt-1',
  } as never);
  const reloaded = await Transaction.findByPk(txn.id);
  assert.equal(reloaded?.taxTreatmentOverride, 'salary');
});

async function addTxn(account: any, entity: any, household: any, fields: Record<string, unknown>, n: number) {
  return Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2025-05-01', amount: '1000.0000', currency: 'CAD',
    merchantRaw: 'X', merchantClean: 'X',
    importBatch: 'seed', sourceRowFingerprint: `fp-${n}`, sourceIdentityFingerprint: `sif-${n}`,
    ...fields,
  } as never);
}

test('salary treatment routes to employment income', async () => {
  const s = await seedPersonal();
  await addTxn(s.account, s.entity, s.household, { amount: '6000.0000', taxTreatmentOverride: 'salary' }, 1);
  const facts = await buildPersonalFacts(s.entity.id, 2025);
  assert.equal(facts.employmentIncome.length, 1);
  assert.equal(facts.employmentIncome[0].cadAmount.toFixed(2), '6000.00');
  assert.equal(facts.eligibleDividends.length, 0);
});

test('dividend treatments route to eligible/non-eligible buckets', async () => {
  const s = await seedPersonal();
  await addTxn(s.account, s.entity, s.household, { amount: '500.0000', taxTreatmentOverride: 'eligible_dividend' }, 2);
  await addTxn(s.account, s.entity, s.household, { amount: '300.0000', taxTreatmentOverride: 'non_eligible_dividend' }, 3);
  const facts = await buildPersonalFacts(s.entity.id, 2025);
  assert.equal(facts.eligibleDividends.length, 1);
  assert.equal(facts.eligibleDividends[0].cadAmount.toFixed(2), '500.00');
  assert.equal(facts.nonEligibleDividends.length, 1);
  assert.equal(facts.nonEligibleDividends[0].cadAmount.toFixed(2), '300.00');
});

test('loan_advance is not income', async () => {
  const s = await seedPersonal();
  await addTxn(s.account, s.entity, s.household, { amount: '9000.0000', taxTreatmentOverride: 'loan_advance' }, 4);
  const facts = await buildPersonalFacts(s.entity.id, 2025);
  assert.equal(facts.employmentIncome.length, 0);
  assert.equal(facts.eligibleDividends.length, 0);
  assert.equal(facts.nonEligibleDividends.length, 0);
});

test('treatment beats finalCategory — counts once (guard)', async () => {
  const s = await seedPersonal();
  await addTxn(s.account, s.entity, s.household,
    { amount: '4000.0000', finalCategory: 'employment_income', taxTreatmentOverride: 'salary' }, 5);
  const facts = await buildPersonalFacts(s.entity.id, 2025);
  assert.equal(facts.employmentIncome.length, 1, 'must not double-count');
  assert.equal(facts.employmentIncome[0].cadAmount.toFixed(2), '4000.00');
});

test('legacy finalCategory employment_income still counts (treatment null)', async () => {
  const s = await seedPersonal();
  await addTxn(s.account, s.entity, s.household,
    { amount: '7000.0000', finalCategory: 'employment_income' }, 6);
  const facts = await buildPersonalFacts(s.entity.id, 2025);
  assert.equal(facts.employmentIncome.length, 1);
  assert.equal(facts.employmentIncome[0].cadAmount.toFixed(2), '7000.00');
});
