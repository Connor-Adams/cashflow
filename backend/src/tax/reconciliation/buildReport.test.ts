import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../db';
import {
  Account, Entity, Household, InvestmentActivity, Security, Transaction,
} from '../../models';
import { buildReconciliationReport } from './buildReport';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

test('aggregates findings from all detectors and produces counts', async () => {
  const household = await Household.create({ name: 'T' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Inv', householdId: household.id, accountType: 'investment',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);

  // Trigger missing_slip (amount kept under $50 divergence threshold so
  // slip_divergence stays at 0 when no T4 slip exists)
  await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2024-03-15', amount: '40', currency: 'CAD',
    finalCategory: 'employment_income',
    merchantRaw: 'E', merchantClean: 'E',
    importBatch: 'b', sourceRowFingerprint: 'fp1', sourceIdentityFingerprint: 'sif1',
  } as never);

  // Trigger category_misclass
  const security = await Security.create({
    symbol: 'FOO', name: 'Foo', currency: 'CAD', householdId: household.id,
    dividendEligibility: 'unknown',
  } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: security.id,
    activityType: 'dividend', tradeDate: '2024-04-15',
    quantity: null, amount: '100', currency: 'CAD', fees: null,
    description: 'FOO dividend', sourceRowFingerprint: 'fp-foo-1', importBatch: 'b',
  } as never);

  const report = await buildReconciliationReport(entity.id, 2024);
  assert.equal(report.entityId, entity.id);
  assert.equal(report.year, 2024);
  assert.equal(report.findings.length, 2);
  assert.equal(report.counts.missing_slip, 1);
  assert.equal(report.counts.category_misclass, 1);
  assert.equal(report.counts.slip_divergence, 0);
});

test('returns zero-finding report for an entity with no relevant data', async () => {
  const household = await Household.create({ name: 'Empty' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const report = await buildReconciliationReport(entity.id, 2024);
  assert.equal(report.findings.length, 0);
  assert.deepEqual(report.counts, {
    missing_slip: 0,
    slip_divergence: 0,
    category_misclass: 0,
  });
});
