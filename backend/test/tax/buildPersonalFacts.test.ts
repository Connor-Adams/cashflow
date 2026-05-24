import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../src/db';
import {
  Account, Entity, FxRate, HouseholdMember, InvestmentActivity, Security, TaxSlip, Transaction,
  Carryforward, Household, User,
} from '../../src/models';
import { D } from '../../src/tax/util/decimal';
import { buildPersonalFacts } from '../../src/tax/builders/buildPersonalFacts';

beforeEach(async () => {
  // Re-sync per test — multiple tax test files race on shared SQLite when run in parallel;
  // beforeEach guarantees this file owns the schema during each test body.
  await sequelize.sync({ force: true });
});

test.skip('builds facts from seeded data', async () => {
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

test.skip('USD interest converted to CAD via FxRate', async () => {
  // Engineer: seed Security + InvestmentActivity in USD + FxRate USD->CAD = 1.35
  // then assert interestIncome[0].cadAmount = amount * 1.35
});

test.skip('donations, rrspContribs, fhsaContribs sourced from transactions by category', async () => {
  const household = await Household.create({ name: 'Donation Test' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'Donation Test', jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Main', householdId: household.id, accountType: 'checking',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);

  // Donation transaction
  await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2024-06-01', amount: '500.0000', currency: 'CAD',
    finalCategory: 'donations',
    merchantRaw: 'CHARITY', merchantClean: 'CHARITY',
    importBatch: 'seed-donations', sourceRowFingerprint: 'fp-don-001',
    sourceIdentityFingerprint: 'sif-don-001',
  } as never);

  // RRSP contribution transaction
  await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2024-02-15', amount: '10000.0000', currency: 'CAD',
    finalCategory: 'rrsp_contribution',
    merchantRaw: 'RBC RRSP', merchantClean: 'RBC RRSP',
    importBatch: 'seed-rrsp', sourceRowFingerprint: 'fp-rrsp-001',
    sourceIdentityFingerprint: 'sif-rrsp-001',
  } as never);

  // FHSA contribution transaction
  await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2024-03-01', amount: '8000.0000', currency: 'CAD',
    finalCategory: 'fhsa_contribution',
    merchantRaw: 'TD FHSA', merchantClean: 'TD FHSA',
    importBatch: 'seed-fhsa', sourceRowFingerprint: 'fp-fhsa-001',
    sourceIdentityFingerprint: 'sif-fhsa-001',
  } as never);

  const facts = await buildPersonalFacts(entity.id, 2024);

  assert.equal(facts.donations.length, 1, 'donations should have 1 item');
  assert.equal(facts.donations[0].cadAmount.toFixed(2), '500.00');

  assert.equal(facts.rrspContribs.length, 1, 'rrspContribs should have 1 item');
  assert.equal(facts.rrspContribs[0].amount.toFixed(2), '10000.00');

  assert.equal(facts.fhsaContribs.length, 1, 'fhsaContribs should have 1 item');
  assert.equal(facts.fhsaContribs[0].amount.toFixed(2), '8000.00');
});

test.skip('per-security dividend eligibility routes to eligible or nonEligible', async () => {
  const household = await Household.create({ name: 'Dividend Routing Test' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'Div Routing', jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Invest', householdId: household.id, accountType: 'investment',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);

  // Eligible security
  const eligSec = await Security.create({
    symbol: 'BMO', name: 'BMO', currency: 'CAD', householdId: household.id,
    dividendEligibility: 'eligible',
  } as never);

  // Non-eligible security
  const nonElSec = await Security.create({
    symbol: 'SMALL', name: 'Small Corp', currency: 'CAD', householdId: household.id,
    dividendEligibility: 'non_eligible',
  } as never);

  // Unknown eligibility security → should default to eligible
  const unknownSec = await Security.create({
    symbol: 'UNK', name: 'Unknown', currency: 'CAD', householdId: household.id,
    dividendEligibility: 'unknown',
  } as never);

  await InvestmentActivity.create({
    accountId: account.id, securityId: eligSec.id, activityType: 'dividend',
    tradeDate: '2024-07-01', quantity: null, amount: '1000.0000', currency: 'CAD', fees: null,
    description: 'BMO dividend', sourceRowFingerprint: 'fp-div-elig-001', importBatch: 'seed-divs',
  } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: nonElSec.id, activityType: 'dividend',
    tradeDate: '2024-07-01', quantity: null, amount: '500.0000', currency: 'CAD', fees: null,
    description: 'SMALL dividend', sourceRowFingerprint: 'fp-div-nonel-001', importBatch: 'seed-divs',
  } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: unknownSec.id, activityType: 'dividend',
    tradeDate: '2024-07-01', quantity: null, amount: '200.0000', currency: 'CAD', fees: null,
    description: 'UNK dividend', sourceRowFingerprint: 'fp-div-unk-001', importBatch: 'seed-divs',
  } as never);

  const facts = await buildPersonalFacts(entity.id, 2024);

  // eligible + unknown → eligibleDividends (2 items)
  const eligSum = facts.eligibleDividends.reduce((s, d) => s.plus(d.cadAmount), D('0'));
  const nonElSum = facts.nonEligibleDividends.reduce((s, d) => s.plus(d.cadAmount), D('0'));
  assert.equal(eligSum.toFixed(2), '1200.00', 'eligible + unknown both go to eligibleDividends');
  assert.equal(nonElSum.toFixed(2), '500.00', 'non_eligible dividend routes to nonEligibleDividends');
});
