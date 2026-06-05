import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../db';
import {
  Account, Entity, Household, TaxSlip, Transaction,
} from '../../models';
import { detectMissingSlips } from './missingSlipDetector';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

async function seedEntity() {
  const household = await Household.create({ name: 'Test' });
  const entity = await Entity.create({
    householdId: household.id,
    kind: 'personal',
    legalName: 'P',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Chk', householdId: household.id, accountType: 'checking',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  return { household, entity, account };
}

test('flags employment_income txn with no matching T4 slip', async () => {
  const { entity, account, household } = await seedEntity();
  await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2024-03-15', amount: '5000', currency: 'CAD',
    finalCategory: 'employment_income',
    merchantRaw: 'EMP', merchantClean: 'EMP',
    importBatch: 'b', sourceRowFingerprint: 'fp1', sourceIdentityFingerprint: 'sif1',
  } as never);

  const findings = await detectMissingSlips(entity.id, 2024);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, 'missing_slip');
  assert.equal(findings[0].severity, 'warning');
  assert.match(findings[0].message, /T4/);
});

test('does not flag when matching T4 slip exists', async () => {
  const { entity, account, household } = await seedEntity();
  await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2024-03-15', amount: '5000', currency: 'CAD',
    finalCategory: 'employment_income',
    merchantRaw: 'EMP', merchantClean: 'EMP',
    importBatch: 'b', sourceRowFingerprint: 'fp1', sourceIdentityFingerprint: 'sif1',
  } as never);
  await TaxSlip.create({
    entityId: entity.id, year: 2024, slipType: 'T4', issuer: 'EMP',
    boxValues: { box14: 5000 },
  } as never);

  const findings = await detectMissingSlips(entity.id, 2024);
  assert.equal(findings.length, 0);
});

test('does not flag when no employment_income txns exist', async () => {
  const { entity } = await seedEntity();
  const findings = await detectMissingSlips(entity.id, 2024);
  assert.equal(findings.length, 0);
});
