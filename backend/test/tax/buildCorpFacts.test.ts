import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../src/db';
import {
  Account,
  Carryforward,
  Entity,
  Household,
  InvestmentActivity,
  Security,
  ShareholderLoan,
  Transaction,
} from '../../src/models';
import { D } from '../../src/tax/util/decimal';
import { buildCorpFacts } from '../../src/tax/builders/buildCorpFacts';

before(async () => {
  await sequelize.sync({ force: true });
});

test('builds corp facts from seeded business transaction', async () => {
  const household = await Household.create({ name: 'Corp Test HH' });
  const entity = await Entity.create({
    householdId: household.id,
    kind: 'corp',
    legalName: '1234567 Canada Inc.',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Corp Chequing',
    householdId: household.id,
    accountType: 'checking',
    entityId: entity.id,
    taxStatus: 'non_registered',
    defaultCurrency: 'CAD',
  } as never);

  // Business transaction — should appear in activeBusinessIncome
  await Transaction.create({
    accountId: account.id,
    householdId: household.id,
    entityId: entity.id,
    date: '2025-06-15',
    amount: '120000.0000',
    currency: 'CAD',
    finalCategory: 'business_income',
    finalBusiness: true,
    merchantRaw: 'CLIENT ABC',
    merchantClean: 'CLIENT ABC',
    importBatch: 'test-corp-seed',
    sourceRowFingerprint: 'fp-corp-001',
    sourceIdentityFingerprint: 'sif-corp-001',
  } as never);

  // Non-business transaction — should NOT appear in activeBusinessIncome
  await Transaction.create({
    accountId: account.id,
    householdId: household.id,
    entityId: entity.id,
    date: '2025-07-01',
    amount: '500.0000',
    currency: 'CAD',
    finalCategory: 'other',
    finalBusiness: false,
    merchantRaw: 'OFFICE SUPPLIES',
    merchantClean: 'OFFICE SUPPLIES',
    importBatch: 'test-corp-seed',
    sourceRowFingerprint: 'fp-corp-002',
    sourceIdentityFingerprint: 'sif-corp-002',
  } as never);

  const fiscalYear = { startDate: '2025-01-01', endDate: '2025-12-31' };
  const facts = await buildCorpFacts(entity.id, fiscalYear);

  assert.equal(facts.fiscalYear.startDate, '2025-01-01');
  assert.equal(facts.fiscalYear.endDate, '2025-12-31');
  assert.equal(facts.jurisdiction, 'CA-ON');
  assert.equal(facts.activeBusinessIncome.length, 1, 'only business txn included');
  assert.equal(facts.activeBusinessIncome[0].cadAmount.toFixed(2), '120000.00');
  assert.ok(Array.isArray(facts.investmentIncome.interest));
  assert.ok(Array.isArray(facts.investmentIncome.eligibleDividends));
  assert.ok(Array.isArray(facts.investmentIncome.nonEligibleDividends));
  assert.ok(Array.isArray(facts.capitalGainEvents));
  assert.ok(Array.isArray(facts.dividendsPaid));
  assert.ok(facts.salaryPaid.equals(D(0)));
});

test('rejects non-corp entity', async () => {
  const household = await Household.create({ name: 'Personal HH' });
  const entity = await Entity.create({
    householdId: household.id,
    kind: 'personal',
    legalName: 'Jane Doe',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  });
  const fiscalYear = { startDate: '2025-01-01', endDate: '2025-12-31' };
  await assert.rejects(
    () => buildCorpFacts(entity.id, fiscalYear),
    /is not corp/,
  );
});

test('populates dividendsPaid and salaryPaid from ShareholderLoan rows', async () => {
  const household = await Household.create({ name: 'Corp SL HH' });
  const entity = await Entity.create({
    householdId: household.id,
    kind: 'corp',
    legalName: '9876543 Canada Inc.',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  });

  // dividend_credit → dividendsPaid
  await ShareholderLoan.create({
    entityId: entity.id,
    date: '2025-03-31',
    kind: 'dividend_credit',
    amount: '50000.0000',
    description: 'Q1 dividend',
  } as never);

  // salary_credit → salaryPaid
  await ShareholderLoan.create({
    entityId: entity.id,
    date: '2025-01-31',
    kind: 'salary_credit',
    amount: '8000.0000',
    description: 'Jan salary',
  } as never);
  await ShareholderLoan.create({
    entityId: entity.id,
    date: '2025-02-28',
    kind: 'salary_credit',
    amount: '8000.0000',
    description: 'Feb salary',
  } as never);

  // advance — should not affect dividendsPaid or salaryPaid
  await ShareholderLoan.create({
    entityId: entity.id,
    date: '2025-04-01',
    kind: 'advance',
    amount: '5000.0000',
    description: 'Loan draw',
  } as never);

  const fiscalYear = { startDate: '2025-01-01', endDate: '2025-12-31' };
  const facts = await buildCorpFacts(entity.id, fiscalYear);

  assert.equal(facts.dividendsPaid.length, 1);
  assert.equal(facts.dividendsPaid[0].amount.toFixed(2), '50000.00');
  assert.equal(facts.dividendsPaid[0].kind, 'non_eligible');

  assert.equal(facts.salaryPaid.toFixed(2), '16000.00', 'two salary credits summed');
});

test('zero carryforwards when none seeded', async () => {
  const household = await Household.create({ name: 'Corp Zero CF HH' });
  const entity = await Entity.create({
    householdId: household.id,
    kind: 'corp',
    legalName: '1111111 Canada Inc.',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  });

  const fiscalYear = { startDate: '2025-01-01', endDate: '2025-12-31' };
  const facts = await buildCorpFacts(entity.id, fiscalYear);

  assert.ok(facts.carryforwards.grip.equals(D(0)));
  assert.ok(facts.carryforwards.cda.equals(D(0)));
  assert.ok(facts.carryforwards.erdtoh.equals(D(0)));
  assert.ok(facts.carryforwards.nerdtoh.equals(D(0)));
  assert.ok(facts.carryforwards.nonCapLoss.equals(D(0)));
  assert.ok(facts.carryforwards.netCapitalLoss.equals(D(0)));
});

test('dividend investment income routes to eligible vs non_eligible by security', async () => {
  const household = await Household.create({ name: 'Corp Div HH' });
  const entity = await Entity.create({
    householdId: household.id,
    kind: 'corp',
    legalName: '2222222 Canada Inc.',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Corp Invest',
    householdId: household.id,
    accountType: 'investment',
    entityId: entity.id,
    taxStatus: 'non_registered',
    defaultCurrency: 'CAD',
  } as never);

  const eligSec = await Security.create({
    symbol: 'TD',
    name: 'TD Bank',
    currency: 'CAD',
    householdId: household.id,
    dividendEligibility: 'eligible',
  } as never);
  const nonElSec = await Security.create({
    symbol: 'PRIV',
    name: 'Private Corp',
    currency: 'CAD',
    householdId: household.id,
    dividendEligibility: 'non_eligible',
  } as never);

  await InvestmentActivity.create({
    accountId: account.id,
    securityId: eligSec.id,
    activityType: 'dividend',
    tradeDate: '2025-04-01',
    quantity: null,
    amount: '3000.0000',
    currency: 'CAD',
    fees: null,
    description: 'TD eligible div',
    sourceRowFingerprint: 'fp-corp-div-001',
    importBatch: 'seed-corp-divs',
  } as never);
  await InvestmentActivity.create({
    accountId: account.id,
    securityId: nonElSec.id,
    activityType: 'dividend',
    tradeDate: '2025-04-01',
    quantity: null,
    amount: '1500.0000',
    currency: 'CAD',
    fees: null,
    description: 'Private corp non-el div',
    sourceRowFingerprint: 'fp-corp-div-002',
    importBatch: 'seed-corp-divs',
  } as never);

  const fiscalYear = { startDate: '2025-01-01', endDate: '2025-12-31' };
  const facts = await buildCorpFacts(entity.id, fiscalYear);

  const eligSum = facts.investmentIncome.eligibleDividends.reduce(
    (s, d) => s.plus(d.cadAmount),
    D('0'),
  );
  const nonElSum = facts.investmentIncome.nonEligibleDividends.reduce(
    (s, d) => s.plus(d.cadAmount),
    D('0'),
  );

  assert.equal(eligSum.toFixed(2), '3000.00');
  assert.equal(nonElSum.toFixed(2), '1500.00');
});
