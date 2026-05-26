import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../../src/db';
import { Account, Entity, Household, TaxSlip, Transaction } from '../../../src/models';
import { detectSlipDivergence } from '../../../src/tax/reconciliation/slipDivergenceDetector';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

async function seed(opts: { txnAmount: string; slipBox14: number }) {
  const household = await Household.create({ name: 'Test' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Chk', householdId: household.id, accountType: 'checking',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2024-03-15', amount: opts.txnAmount, currency: 'CAD',
    finalCategory: 'employment_income',
    merchantRaw: 'EMP', merchantClean: 'EMP',
    importBatch: 'b', sourceRowFingerprint: 'fp1', sourceIdentityFingerprint: 'sif1',
  } as never);
  await TaxSlip.create({
    entityId: entity.id, year: 2024, slipType: 'T4', issuer: 'EMP',
    boxValues: { box14: opts.slipBox14 },
  } as never);
  return { entity };
}

test('no finding when slip and txn match within $50', async () => {
  const { entity } = await seed({ txnAmount: '5000', slipBox14: 5020 });
  const findings = await detectSlipDivergence(entity.id, 2024);
  assert.equal(findings.length, 0);
});

test('emits finding when slip and txn differ by more than $50', async () => {
  const { entity } = await seed({ txnAmount: '5000', slipBox14: 6000 });
  const findings = await detectSlipDivergence(entity.id, 2024);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, 'slip_divergence');
  assert.equal(findings[0].severity, 'warning');
  assert.match(findings[0].message, /1000\.00/);
});

test('no finding when neither slip nor txns exist', async () => {
  const household = await Household.create({ name: 'Empty' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const findings = await detectSlipDivergence(entity.id, 2024);
  assert.equal(findings.length, 0);
});
