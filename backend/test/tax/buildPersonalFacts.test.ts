import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../src/db';
import {
  Account, Category, Entity, FxRate, HouseholdMember, InvestmentActivity, Security, TaxSlip, Transaction,
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

test('captures self-employment income/expenses from business-flagged transactions', async () => {
  // Regression: buildPersonalFacts read (t as any).business, but the Transaction
  // attribute is finalBusiness (column final_business). The wrong field name —
  // hidden by an `as any` cast — meant business-flagged transactions never reached
  // selfEmploymentIncome/selfEmploymentExpenses, silently dropping that income.
  const household = await Household.create({ name: 'Self-Employment' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'Sole Prop', jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Business', householdId: household.id, accountType: 'checking',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);

  // Business revenue (positive) and a business expense (negative), both flagged.
  await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2025-04-10', amount: '50000.0000', currency: 'CAD',
    finalCategory: 'consulting', finalBusiness: true,
    merchantRaw: 'CLIENT', merchantClean: 'CLIENT',
    importBatch: 'seed-se', sourceRowFingerprint: 'fp-se-inc-001', sourceIdentityFingerprint: 'sif-se-inc-001',
  } as never);
  await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2025-05-02', amount: '-8000.0000', currency: 'CAD',
    finalCategory: 'supplies', finalBusiness: true,
    merchantRaw: 'SUPPLIER', merchantClean: 'SUPPLIER',
    importBatch: 'seed-se', sourceRowFingerprint: 'fp-se-exp-001', sourceIdentityFingerprint: 'sif-se-exp-001',
  } as never);

  const facts = await buildPersonalFacts(entity.id, 2025);

  assert.equal(facts.selfEmploymentIncome.length, 1, 'business revenue captured');
  assert.equal(facts.selfEmploymentIncome[0].cadAmount.toFixed(2), '50000.00');
  assert.equal(facts.selfEmploymentExpenses.length, 1, 'business expense captured');
  assert.equal(facts.selfEmploymentExpenses[0].cadAmount.toFixed(2), '8000.00');
});

test('tolerates an investment activity with a null amount (e.g. activityType "other")', async () => {
  // Regression: InvestmentActivity.amount is nullable. The income loop builds
  // D(a.amount) for EVERY activity row before branching on activityType, so a
  // non-income row (activityType "other") with a null amount used to crash with
  // "[DecimalError] Invalid argument: null" — which broke every personal Tax tab
  // (Overview / Personal T1 / Reconciliation all funnel through buildPersonalFacts).
  const household = await Household.create({ name: 'Null Amount Activity' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'Null Amt', jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Invest', householdId: household.id, accountType: 'investment',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);

  // Mirrors prod rows (account 10, 2025-01-22): activity_type 'other', amount NULL.
  await InvestmentActivity.create({
    accountId: account.id, securityId: null, activityType: 'other',
    tradeDate: '2025-01-22', quantity: null, amount: null, currency: 'CAD', fees: null,
    description: 'corporate action', sourceRowFingerprint: 'fp-other-null-001', importBatch: 'seed-null-amt',
  } as never);

  const facts = await buildPersonalFacts(entity.id, 2025);

  // A null-amount "other" activity is not income; it must be ignored, not crash.
  assert.equal(facts.interestIncome.length, 0, 'no interest income');
  assert.equal(facts.eligibleDividends.length, 0, 'no eligible dividends');
  assert.equal(facts.nonEligibleDividends.length, 0, 'no non-eligible dividends');
});

test('category taxTreatment routes a transaction into employment income', async () => {
  const household = await Household.create({ name: 'TT employment' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P', jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Chk', householdId: household.id, accountType: 'checking',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  await Category.create({
    householdId: household.id, name: 'Salary', taxTreatment: 'employment_income',
  } as never);
  await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2025-02-01', amount: '60000.0000', currency: 'CAD', finalCategory: 'Salary',
    merchantRaw: 'EMP', merchantClean: 'EMP', importBatch: 's',
    sourceRowFingerprint: 'fp-tt-emp-1', sourceIdentityFingerprint: 'sif-tt-emp-1',
  } as never);

  const facts = await buildPersonalFacts(entity.id, 2025);
  assert.equal(facts.employmentIncome.length, 1, 'category treatment feeds employment income');
  assert.equal(facts.employmentIncome[0].cadAmount.toFixed(2), '60000.00');
});

test('transaction taxTreatmentOverride wins over the category default', async () => {
  const household = await Household.create({ name: 'TT override' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P', jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Chk', householdId: household.id, accountType: 'checking',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  // Category default is 'none'; the override forces a donation.
  await Category.create({ householdId: household.id, name: 'Misc' } as never);
  await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2025-03-01', amount: '500.0000', currency: 'CAD', finalCategory: 'Misc',
    taxTreatmentOverride: 'donations',
    merchantRaw: 'CH', merchantClean: 'CH', importBatch: 's',
    sourceRowFingerprint: 'fp-tt-ovr-1', sourceIdentityFingerprint: 'sif-tt-ovr-1',
  } as never);

  const facts = await buildPersonalFacts(entity.id, 2025);
  assert.equal(facts.donations.length, 1, 'override beats category default');
  assert.equal(facts.donations[0].cadAmount.toFixed(2), '500.00');
});

// ---------------------------------------------------------------------------
// Income-bearing InvestmentActivity types beyond dividend/interest/sell, plus
// the cap-gains ACB window. Regression for the T1 income undercount:
// buildPersonalFacts silently DROPPED 'reinvestment' (DRIP) and 'staking_reward'
// rows, and fed computeAcb only the tax YEAR's activity — zeroing ACB on
// prior-year holdings and overstating realized gains.
// ---------------------------------------------------------------------------

async function seedPersonalInvestmentAccount(name: string) {
  const household = await Household.create({ name });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: name, jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Invest', householdId: household.id, accountType: 'investment',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  return { household, entity, account };
}

const sumCad = (items: { cadAmount: ReturnType<typeof D> }[]) =>
  items.reduce((s, i) => s.plus(i.cadAmount), D('0'));

test('reinvestment (DRIP) rows are taxable dividend income, routed by security eligibility', async () => {
  // A Questrade/OFX DRIP emits a SINGLE 'reinvestment' row carrying the dividend
  // amount — there is NO paired 'dividend' row — so dropping it loses the income.
  const { household, entity, account } = await seedPersonalInvestmentAccount('DRIP routing');
  const eligSec = await Security.create({
    symbol: 'XEI', name: 'iShares Cdn Div', currency: 'CAD', householdId: household.id, dividendEligibility: 'eligible',
  } as never);
  const nonElSec = await Security.create({
    symbol: 'REIT', name: 'Small REIT', currency: 'CAD', householdId: household.id, dividendEligibility: 'non_eligible',
  } as never);

  await InvestmentActivity.create({
    accountId: account.id, securityId: eligSec.id, activityType: 'reinvestment',
    tradeDate: '2025-03-15', quantity: '2.0000', amount: '100.0000', currency: 'CAD', fees: null,
    description: 'DRIP', sourceRowFingerprint: 'fp-drip-elig', importBatch: 'seed',
  } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: nonElSec.id, activityType: 'reinvestment',
    tradeDate: '2025-06-15', quantity: '1.0000', amount: '40.0000', currency: 'CAD', fees: null,
    description: 'DRIP', sourceRowFingerprint: 'fp-drip-nonel', importBatch: 'seed',
  } as never);

  const facts = await buildPersonalFacts(entity.id, 2025);

  assert.equal(sumCad(facts.eligibleDividends).toFixed(2), '100.00', 'eligible DRIP is dividend income');
  assert.equal(sumCad(facts.nonEligibleDividends).toFixed(2), '40.00', 'non-eligible DRIP routes to non-eligible dividends');
});

test('staking_reward rows are taxable income on the interest line (L12100)', async () => {
  const { household, entity, account } = await seedPersonalInvestmentAccount('Staking income');
  const sec = await Security.create({
    symbol: 'ETH', name: 'Ether', currency: 'CAD', householdId: household.id,
  } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: sec.id, activityType: 'staking_reward',
    tradeDate: '2025-04-01', quantity: '0.0030', amount: '8.92', currency: 'CAD', fees: null,
    description: 'CRYPTORWD', sourceRowFingerprint: 'fp-stake-1', importBatch: 'seed',
  } as never);

  const facts = await buildPersonalFacts(entity.id, 2025);
  assert.equal(sumCad(facts.interestIncome).toFixed(2), '8.92', 'staking reward is ordinary income on L12100');
});

test('same-year buy then sell computes the capital gain from ACB (regression lock)', async () => {
  const { household, entity, account } = await seedPersonalInvestmentAccount('Same-year sell');
  const sec = await Security.create({ symbol: 'ABC', name: 'ABC', currency: 'CAD', householdId: household.id } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: sec.id, activityType: 'buy',
    tradeDate: '2025-02-01', quantity: '100.0000', amount: '1000.0000', currency: 'CAD', fees: null,
    description: 'buy', sourceRowFingerprint: 'fp-buy-sy', importBatch: 'seed',
  } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: sec.id, activityType: 'sell',
    tradeDate: '2025-09-01', quantity: '100.0000', amount: '1200.0000', currency: 'CAD', fees: null,
    description: 'sell', sourceRowFingerprint: 'fp-sell-sy', importBatch: 'seed',
  } as never);

  const facts = await buildPersonalFacts(entity.id, 2025);
  assert.equal(facts.capitalGainEvents.length, 1);
  assert.equal(facts.capitalGainEvents[0].proceeds.toFixed(2), '1200.00');
  assert.equal(facts.capitalGainEvents[0].acb.toFixed(2), '1000.00');
});

test('same-year return_of_capital reduces ACB and raises the realized gain (regression lock)', async () => {
  const { household, entity, account } = await seedPersonalInvestmentAccount('Same-year ROC');
  const sec = await Security.create({ symbol: 'ROC', name: 'ROC Fund', currency: 'CAD', householdId: household.id } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: sec.id, activityType: 'buy',
    tradeDate: '2025-01-10', quantity: '100.0000', amount: '1000.0000', currency: 'CAD', fees: null,
    description: 'buy', sourceRowFingerprint: 'fp-buy-roc', importBatch: 'seed',
  } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: sec.id, activityType: 'return_of_capital',
    tradeDate: '2025-05-10', quantity: null, amount: '200.0000', currency: 'CAD', fees: null,
    description: 'ROC', sourceRowFingerprint: 'fp-roc', importBatch: 'seed',
  } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: sec.id, activityType: 'sell',
    tradeDate: '2025-11-10', quantity: '100.0000', amount: '1200.0000', currency: 'CAD', fees: null,
    description: 'sell', sourceRowFingerprint: 'fp-sell-roc', importBatch: 'seed',
  } as never);

  const facts = await buildPersonalFacts(entity.id, 2025);
  assert.equal(facts.capitalGainEvents.length, 1);
  assert.equal(facts.capitalGainEvents[0].acb.toFixed(2), '800.00', 'ROC reduced ACB by 200');
  assert.equal(facts.capitalGainEvents[0].proceeds.toFixed(2), '1200.00');
});

test('capital gain uses ACB from prior-year buys, not just current-year rows', async () => {
  const { household, entity, account } = await seedPersonalInvestmentAccount('Prior-year buy');
  const sec = await Security.create({ symbol: 'PY', name: 'PriorYear', currency: 'CAD', householdId: household.id } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: sec.id, activityType: 'buy',
    tradeDate: '2024-04-01', quantity: '100.0000', amount: '1000.0000', currency: 'CAD', fees: null,
    description: 'buy', sourceRowFingerprint: 'fp-buy-py', importBatch: 'seed',
  } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: sec.id, activityType: 'sell',
    tradeDate: '2025-04-01', quantity: '100.0000', amount: '1200.0000', currency: 'CAD', fees: null,
    description: 'sell', sourceRowFingerprint: 'fp-sell-py', importBatch: 'seed',
  } as never);

  const facts = await buildPersonalFacts(entity.id, 2025);
  assert.equal(facts.capitalGainEvents.length, 1, 'only the 2025 disposition');
  assert.equal(facts.capitalGainEvents[0].proceeds.toFixed(2), '1200.00');
  assert.equal(facts.capitalGainEvents[0].acb.toFixed(2), '1000.00', 'ACB carried from the 2024 buy, not zeroed');
});

test('prior-year buy and return_of_capital both feed ACB for a current-year sale', async () => {
  const { household, entity, account } = await seedPersonalInvestmentAccount('Prior-year ROC');
  const sec = await Security.create({ symbol: 'PYR', name: 'PriorYearROC', currency: 'CAD', householdId: household.id } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: sec.id, activityType: 'buy',
    tradeDate: '2024-03-01', quantity: '100.0000', amount: '1000.0000', currency: 'CAD', fees: null,
    description: 'buy', sourceRowFingerprint: 'fp-buy-pyr', importBatch: 'seed',
  } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: sec.id, activityType: 'return_of_capital',
    tradeDate: '2024-09-01', quantity: null, amount: '200.0000', currency: 'CAD', fees: null,
    description: 'ROC', sourceRowFingerprint: 'fp-roc-pyr', importBatch: 'seed',
  } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: sec.id, activityType: 'sell',
    tradeDate: '2025-03-01', quantity: '100.0000', amount: '1200.0000', currency: 'CAD', fees: null,
    description: 'sell', sourceRowFingerprint: 'fp-sell-pyr', importBatch: 'seed',
  } as never);

  const facts = await buildPersonalFacts(entity.id, 2025);
  assert.equal(facts.capitalGainEvents.length, 1);
  assert.equal(facts.capitalGainEvents[0].acb.toFixed(2), '800.00', 'prior-year ROC reduced the carried ACB');
  assert.equal(facts.capitalGainEvents[0].proceeds.toFixed(2), '1200.00');
});

test('prior-year dispositions are excluded from the current-year capital gains', async () => {
  const { household, entity, account } = await seedPersonalInvestmentAccount('Prior-year sell excluded');
  const sec = await Security.create({ symbol: 'EX', name: 'Excl', currency: 'CAD', householdId: household.id } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: sec.id, activityType: 'buy',
    tradeDate: '2023-01-01', quantity: '200.0000', amount: '2000.0000', currency: 'CAD', fees: null,
    description: 'buy', sourceRowFingerprint: 'fp-buy-ex', importBatch: 'seed',
  } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: sec.id, activityType: 'sell',
    tradeDate: '2024-06-01', quantity: '100.0000', amount: '1500.0000', currency: 'CAD', fees: null,
    description: 'sell 2024', sourceRowFingerprint: 'fp-sell-ex-24', importBatch: 'seed',
  } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: sec.id, activityType: 'sell',
    tradeDate: '2025-06-01', quantity: '100.0000', amount: '1800.0000', currency: 'CAD', fees: null,
    description: 'sell 2025', sourceRowFingerprint: 'fp-sell-ex-25', importBatch: 'seed',
  } as never);

  const facts = await buildPersonalFacts(entity.id, 2025);
  assert.equal(facts.capitalGainEvents.length, 1, 'only the 2025 disposition is reported');
  assert.equal(facts.capitalGainEvents[0].proceeds.toFixed(2), '1800.00');
  assert.equal(facts.capitalGainEvents[0].acb.toFixed(2), '1000.00', 'ACB/unit 10 from the 2023 buy survives the 2024 partial sell');
});

test('a reinvestment is deduped against a synthetic Alpha Vantage dividend for the same payout', async () => {
  // A Questrade DRIP imports as a single 'reinvestment' row with NO paired
  // 'dividend'. The AV reconciler (which dedups only against
  // activityType='dividend') then inserts a SYNTHETIC 'dividend' for the same
  // ex-date payout. Counting both would double-count the dividend income.
  const { household, entity, account } = await seedPersonalInvestmentAccount('DRIP dedup');
  const sec = await Security.create({
    symbol: 'XEI', name: 'iShares Cdn Div', currency: 'CAD', householdId: household.id, dividendEligibility: 'eligible',
  } as never);

  // Broker DRIP row carrying the $100 reinvested dividend.
  await InvestmentActivity.create({
    accountId: account.id, securityId: sec.id, activityType: 'reinvestment',
    tradeDate: '2025-03-12', quantity: '2.0000', amount: '100.0000', currency: 'CAD', fees: null,
    description: 'DRIP', sourceRowFingerprint: 'fp-drip-dedup', importBatch: 'seed',
  } as never);
  // Synthetic AV dividend for the SAME payout, ex-date 2 days earlier (within the
  // 5-day default dedup window).
  await InvestmentActivity.create({
    accountId: account.id, securityId: sec.id, activityType: 'dividend',
    tradeDate: '2025-03-10', quantity: null, amount: '100.0000', currency: 'CAD', fees: null,
    description: 'Dividend reconciled from Alpha Vantage', sourceRowFingerprint: 'fp-av-dedup',
    importBatch: 'alpha_vantage:dividends',
  } as never);

  const facts = await buildPersonalFacts(entity.id, 2025);
  // The payout must be counted ONCE ($100), not twice ($200).
  assert.equal(sumCad(facts.eligibleDividends).toFixed(2), '100.00', 'DRIP + synthetic dividend is a single $100 payout');
});

test('a reinvestment outside the dedup window of any dividend is still counted', async () => {
  // A March DRIP and an unrelated September cash dividend are different payouts;
  // the window must not let the far dividend swallow the DRIP.
  const { household, entity, account } = await seedPersonalInvestmentAccount('DRIP no-overlap');
  const sec = await Security.create({
    symbol: 'XEI', name: 'iShares Cdn Div', currency: 'CAD', householdId: household.id, dividendEligibility: 'eligible',
  } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: sec.id, activityType: 'reinvestment',
    tradeDate: '2025-03-12', quantity: '2.0000', amount: '100.0000', currency: 'CAD', fees: null,
    description: 'DRIP', sourceRowFingerprint: 'fp-drip-far', importBatch: 'seed',
  } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: sec.id, activityType: 'dividend',
    tradeDate: '2025-09-15', quantity: null, amount: '60.0000', currency: 'CAD', fees: null,
    description: 'cash dividend', sourceRowFingerprint: 'fp-div-far', importBatch: 'seed',
  } as never);

  const facts = await buildPersonalFacts(entity.id, 2025);
  assert.equal(sumCad(facts.eligibleDividends).toFixed(2), '160.00', 'far-apart DRIP and dividend are both counted');
});

test('a reinvestment is NOT deduped against a same-security dividend in a DIFFERENT account', async () => {
  // Two non-registered accounts both hold the same ETF. The AV reconciler always
  // inserts its synthetic dividend into the SAME account as the holding, so a
  // DRIP in account A and a cash dividend in account B on the same date are
  // DISTINCT payouts and must both be counted.
  const household = await Household.create({ name: 'DRIP cross-account' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'X-Acct', jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const accountA = await Account.create({
    name: 'A', householdId: household.id, accountType: 'investment',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  const accountB = await Account.create({
    name: 'B', householdId: household.id, accountType: 'investment',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  const sec = await Security.create({
    symbol: 'XEI', name: 'iShares Cdn Div', currency: 'CAD', householdId: household.id, dividendEligibility: 'eligible',
  } as never);
  await InvestmentActivity.create({
    accountId: accountA.id, securityId: sec.id, activityType: 'reinvestment',
    tradeDate: '2025-03-12', quantity: '2.0000', amount: '100.0000', currency: 'CAD', fees: null,
    description: 'DRIP', sourceRowFingerprint: 'fp-xacct-drip', importBatch: 'seed',
  } as never);
  await InvestmentActivity.create({
    accountId: accountB.id, securityId: sec.id, activityType: 'dividend',
    tradeDate: '2025-03-12', quantity: null, amount: '70.0000', currency: 'CAD', fees: null,
    description: 'cash dividend', sourceRowFingerprint: 'fp-xacct-div', importBatch: 'seed',
  } as never);

  const facts = await buildPersonalFacts(entity.id, 2025);
  assert.equal(sumCad(facts.eligibleDividends).toFixed(2), '170.00', 'distinct accounts are distinct payouts; both counted');
});
