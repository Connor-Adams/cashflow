import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../db';
import {
  Account,
  Carryforward,
  Entity,
  FxRate,
  Household,
  InvestmentActivity,
  Security,
  ShareholderLoan,
  Transaction,
} from '../../models';
import { D } from '../util/decimal';
import { buildCorpFacts } from './buildCorpFacts';

beforeEach(async () => {
  // Re-sync per test — multiple tax test files race on shared SQLite when run in parallel;
  // beforeEach guarantees this file owns the schema during each test body.
  await sequelize.sync({ force: true });
});

// NOTE: this test was already skipped, and its premise is now obsolete —
// `finalBusiness` no longer decides what counts as active business income. See
// corpPerimeter.ts and the perimeter tests at the bottom of this file for the
// current rule. Do not un-skip without rewriting the assertions.
test.skip('builds corp facts from seeded business transaction', async () => {
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

test('tolerates an investment activity with a null amount (e.g. activityType "other")', async () => {
  // Regression mirror of buildPersonalFacts: InvestmentActivity.amount is nullable.
  // The income loop builds D(a.amount) for every activity row before branching on
  // activityType, so a non-income "other" row with a null amount used to crash with
  // "[DecimalError] Invalid argument: null" — which would break the Corp tax tabs.
  const household = await Household.create({ name: 'Corp Null Amount' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'corp', legalName: 'NullAmt Inc.', jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Corp Invest', householdId: household.id, accountType: 'investment',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: null, activityType: 'other',
    tradeDate: '2025-03-15', quantity: null, amount: null, currency: 'CAD', fees: null,
    description: 'corporate action', sourceRowFingerprint: 'fp-corp-other-null-001', importBatch: 'seed-corp-null-amt',
  } as never);

  const facts = await buildCorpFacts(entity.id, { startDate: '2025-01-01', endDate: '2025-12-31' });

  // A null-amount "other" activity is not income; it must be ignored, not crash.
  assert.equal(facts.investmentIncome.interest.length, 0, 'no interest');
  assert.equal(facts.investmentIncome.eligibleDividends.length, 0, 'no eligible dividends');
  assert.equal(facts.investmentIncome.nonEligibleDividends.length, 0, 'no non-eligible dividends');
});

async function seedCorpInvestmentAccount(name: string) {
  const household = await Household.create({ name });
  const entity = await Entity.create({
    householdId: household.id, kind: 'corp', legalName: `${name} Inc.`, jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Corp Invest', householdId: household.id, accountType: 'investment',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  return { household, entity, account };
}

test('counts both salary and employment_income overrides as salaryPaid', async () => {
  // Prod tags corp-paid remuneration as 'employment_income', the synonym of
  // 'salary' in TAX_TREATMENTS. buildPersonalFacts already treats them as one;
  // buildCorpFacts must too, or corp-side salary (and its deduction) vanishes.
  const household = await Household.create({ name: 'Corp Salary HH' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'corp', legalName: 'Salary Inc.', jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Corp Chequing', householdId: household.id, accountType: 'checking',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  // Corp-paid salary tagged with the canonical 'salary' token (outflow leg).
  await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2025-03-15', amount: '-5000.0000', currency: 'CAD',
    finalCategory: 'salary', finalBusiness: false,
    merchantRaw: 'PAYROLL', merchantClean: 'PAYROLL',
    importBatch: 'seed-corp-sal', sourceRowFingerprint: 'fp-corp-sal-1', sourceIdentityFingerprint: 'sif-corp-sal-1',
    taxTreatmentOverride: 'salary',
  } as never);
  // Corp-paid salary tagged with the 'employment_income' synonym (what prod uses).
  await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2025-04-15', amount: '-3000.0000', currency: 'CAD',
    finalCategory: 'employment_income', finalBusiness: false,
    merchantRaw: 'PAYROLL', merchantClean: 'PAYROLL',
    importBatch: 'seed-corp-sal', sourceRowFingerprint: 'fp-corp-sal-2', sourceIdentityFingerprint: 'sif-corp-sal-2',
    taxTreatmentOverride: 'employment_income',
  } as never);

  const facts = await buildCorpFacts(entity.id, { startDate: '2025-01-01', endDate: '2025-12-31' });
  assert.equal(facts.salaryPaid.toFixed(2), '8000.00', 'salary + employment_income both count as corp salary paid');
});

test('corp USD dispositions convert proceeds and ACB to CAD at per-leg trade-date rates', async () => {
  // Same CRA per-leg conversion rule as the personal builder: a USD gain must
  // reach AAII / CDA / RDTOH math in CAD, not native currency.
  const { household, entity, account } = await seedCorpInvestmentAccount('Corp USD gains');
  const sec = await Security.create({ symbol: 'MSFT', name: 'Microsoft', currency: 'USD', householdId: household.id } as never);
  await FxRate.create({
    fromCurrency: 'USD', toCurrency: 'CAD', ratedDate: '2025-02-01',
    rate: '1.30', source: 'manual_seed', fetchedAt: new Date(),
  } as never);
  await FxRate.create({
    fromCurrency: 'USD', toCurrency: 'CAD', ratedDate: '2025-08-01',
    rate: '1.40', source: 'manual_seed', fetchedAt: new Date(),
  } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: sec.id, activityType: 'buy',
    tradeDate: '2025-02-01', quantity: '100.0000', amount: '1000.0000', currency: 'USD', fees: null,
    description: 'buy', sourceRowFingerprint: 'fp-corp-buy-usd', importBatch: 'seed',
  } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: sec.id, activityType: 'sell',
    tradeDate: '2025-08-01', quantity: '100.0000', amount: '1500.0000', currency: 'USD', fees: null,
    description: 'sell', sourceRowFingerprint: 'fp-corp-sell-usd', importBatch: 'seed',
  } as never);

  // Stub fetch so a cache miss can never reach the Bank of Canada API.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('network disabled in buildCorpFacts.test.ts');
  }) as unknown as typeof fetch;
  try {
    const facts = await buildCorpFacts(entity.id, { startDate: '2025-01-01', endDate: '2025-12-31' });
    assert.equal(facts.capitalGainEvents.length, 1);
    assert.equal(facts.capitalGainEvents[0].proceeds.toFixed(2), '2100.00', 'US$1500 × 1.40 sale-date rate');
    assert.equal(facts.capitalGainEvents[0].acb.toFixed(2), '1300.00', 'US$1000 × 1.30 buy-date rate');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('corp stock split adjusts per-unit ACB for subsequent sells (splitRatio passthrough)', async () => {
  // Regression mirror of buildPersonalFacts: the map into computeAcb dropped
  // splitRatio, so post-split sells fabricated losses against un-halved ACB.
  const { household, entity, account } = await seedCorpInvestmentAccount('Corp split');
  const sec = await Security.create({ symbol: 'SPLC', name: 'Split Corp', currency: 'CAD', householdId: household.id } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: sec.id, activityType: 'buy',
    tradeDate: '2025-01-10', quantity: '100.0000', amount: '1000.0000', currency: 'CAD', fees: null,
    description: 'buy', sourceRowFingerprint: 'fp-corp-buy-spl', importBatch: 'seed',
  } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: sec.id, activityType: 'split',
    tradeDate: '2025-03-01', quantity: null, amount: null, currency: 'CAD', fees: null,
    splitRatio: '2', description: '2:1 split', sourceRowFingerprint: 'fp-corp-split-spl', importBatch: 'seed',
  } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: sec.id, activityType: 'sell',
    tradeDate: '2025-06-01', quantity: '100.0000', amount: '600.0000', currency: 'CAD', fees: null,
    description: 'sell', sourceRowFingerprint: 'fp-corp-sell-spl', importBatch: 'seed',
  } as never);

  const facts = await buildCorpFacts(entity.id, { startDate: '2025-01-01', endDate: '2025-12-31' });
  assert.equal(facts.capitalGainEvents.length, 1);
  // Post-split: 200 units, cost 1000 → ACB/unit 5. Sell 100 → costRemoved 500.
  assert.equal(facts.capitalGainEvents[0].acb.toFixed(2), '500.00', 'split halves the per-unit ACB');
  assert.equal(facts.capitalGainEvents[0].proceeds.toFixed(2), '600.00');
});

test('corp ACB walk sees buys from PRIOR fiscal years (full-history feed)', async () => {
  // ACB is a weighted-average running balance (ITA s.47) — it needs the full
  // per-security history, not just this fiscal year's rows. A fiscal-windowed
  // feed makes a prior-year buy invisible, so the sell is clamped to a zero
  // position and the whole proceeds are booked as gain.
  const { household, entity, account } = await seedCorpInvestmentAccount('Corp prior-year ACB');
  const sec = await Security.create({ symbol: 'HIST', name: 'History Corp', currency: 'CAD', householdId: household.id } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: sec.id, activityType: 'buy',
    tradeDate: '2024-06-01', quantity: '100.0000', amount: '5000.0000', currency: 'CAD', fees: null,
    description: 'prior-FY buy', sourceRowFingerprint: 'fp-corp-buy-hist', importBatch: 'seed',
  } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: sec.id, activityType: 'sell',
    tradeDate: '2025-08-01', quantity: '100.0000', amount: '6000.0000', currency: 'CAD', fees: null,
    description: 'current-FY sell', sourceRowFingerprint: 'fp-corp-sell-hist', importBatch: 'seed',
  } as never);

  const facts = await buildCorpFacts(entity.id, { startDate: '2025-01-01', endDate: '2025-12-31' });
  assert.equal(facts.capitalGainEvents.length, 1);
  assert.equal(facts.capitalGainEvents[0].acb.toFixed(2), '5000.00', 'prior-year buy must feed the ACB');
  assert.equal(facts.capitalGainEvents[0].proceeds.toFixed(2), '6000.00');
});

test('corp prior-fiscal-year dispositions advance ACB state but emit no event for this year', async () => {
  const { household, entity, account } = await seedCorpInvestmentAccount('Corp prior-year sell');
  const sec = await Security.create({ symbol: 'PRSL', name: 'Prior Sell Corp', currency: 'CAD', householdId: household.id } as never);
  // 2024: buy 200 @ $10/unit, sell 100 — realized in FY2024, not FY2025.
  await InvestmentActivity.create({
    accountId: account.id, securityId: sec.id, activityType: 'buy',
    tradeDate: '2024-02-01', quantity: '200.0000', amount: '2000.0000', currency: 'CAD', fees: null,
    description: 'prior buy', sourceRowFingerprint: 'fp-corp-buy-prsl', importBatch: 'seed',
  } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: sec.id, activityType: 'sell',
    tradeDate: '2024-09-01', quantity: '100.0000', amount: '1500.0000', currency: 'CAD', fees: null,
    description: 'prior sell', sourceRowFingerprint: 'fp-corp-sell-prsl-1', importBatch: 'seed',
  } as never);
  // FY2025: sell the remaining 100 — the only event this fiscal year.
  await InvestmentActivity.create({
    accountId: account.id, securityId: sec.id, activityType: 'sell',
    tradeDate: '2025-05-01', quantity: '100.0000', amount: '1800.0000', currency: 'CAD', fees: null,
    description: 'current sell', sourceRowFingerprint: 'fp-corp-sell-prsl-2', importBatch: 'seed',
  } as never);
  // Prior-year dividend must NOT leak into this fiscal year's income.
  await InvestmentActivity.create({
    accountId: account.id, securityId: sec.id, activityType: 'dividend',
    tradeDate: '2024-12-15', quantity: null, amount: '400.0000', currency: 'CAD', fees: null,
    description: 'prior-FY dividend', sourceRowFingerprint: 'fp-corp-div-prsl', importBatch: 'seed',
  } as never);

  const facts = await buildCorpFacts(entity.id, { startDate: '2025-01-01', endDate: '2025-12-31' });
  assert.equal(facts.capitalGainEvents.length, 1, 'only the FY2025 disposition is reported');
  assert.equal(facts.capitalGainEvents[0].date, '2025-05-01');
  assert.equal(facts.capitalGainEvents[0].acb.toFixed(2), '1000.00', '100 units at $10/unit weighted-average');
  assert.equal(facts.investmentIncome.eligibleDividends.length, 0, 'prior-FY dividend stays out of FY2025 income');
});

test.skip('rejects non-corp entity', async () => {
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

test.skip('populates dividendsPaid and salaryPaid from ShareholderLoan rows', async () => {
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

test.skip('zero carryforwards when none seeded', async () => {
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

test.skip('dividend investment income routes to eligible vs non_eligible by security', async () => {
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

// --- active business income: perimeter rule (replaces the finalBusiness sum) ---
//
// Revenue arrives as a multi-hop chain across the corp's own accounts. Only the
// hop that crosses the corporate perimeter is income; every downstream hop is
// the same dollar moving house. See corpPerimeter.ts for the rule and why
// `linkedTransactionId` alone is not enough to detect an internal leg.

async function seedPerimeterCorp() {
  const household = await Household.create({ name: 'Perimeter HH' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'corp', legalName: 'CDG LABS INC.',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const wiseUsd = await Account.create({
    name: 'Wise Corporate USD', householdId: household.id, accountType: 'checking',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'USD',
  } as never);
  const chequing = await Account.create({
    name: 'Corp Chequing', householdId: household.id, accountType: 'checking',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  return { household, entity, wiseUsd, chequing };
}

let perimeterFp = 0;
async function seedTxn(
  ctx: { household: { id: number }; entity: { id: number } },
  account: { id: number },
  over: Record<string, unknown>,
) {
  perimeterFp += 1;
  const merchantRaw = String(over.merchantRaw ?? 'SEED');
  return Transaction.create({
    accountId: account.id,
    householdId: ctx.household.id,
    entityId: ctx.entity.id,
    currency: 'CAD',
    importBatch: 'test-perimeter',
    merchantClean: merchantRaw,
    sourceRowFingerprint: `fp-perimeter-${perimeterFp}`,
    sourceIdentityFingerprint: `sif-perimeter-${perimeterFp}`,
    ...over,
    merchantRaw,
  } as never);
}

test('active business income counts the external receipt, not the internal hops', async () => {
  const ctx = await seedPerimeterCorp();
  await FxRate.create({
    fromCurrency: 'USD', toCurrency: 'CAD', ratedDate: '2025-03-13',
    rate: '1.40', source: 'manual_seed', fetchedAt: new Date(),
  } as never);

  // Hop 1 — the money enters the corp from a customer. THIS is revenue.
  await seedTxn(ctx, ctx.wiseUsd, {
    date: '2025-03-13', amount: '5000.0000', currency: 'USD', txnType: 'transfer',
    merchantRaw: 'Received money from WANDERCOM', merchantClean: 'Received money from WANDERCOM',
    finalBusiness: false,
  });
  // Hop 2 — leaves Wise, pointing at the arrival row. Internal.
  const out = await seedTxn(ctx, ctx.wiseUsd, {
    date: '2025-03-13', amount: '-5000.0000', currency: 'USD', txnType: 'transfer',
    merchantRaw: 'Sent money to CDG Labs Inc.', finalBusiness: true,
  });
  // Hop 3 — the arrival. Unlinked itself, but it is hop 2's target. Internal.
  const arrival = await seedTxn(ctx, ctx.chequing, {
    date: '2025-03-13', amount: '7000.0000', txnType: 'unknown',
    merchantRaw: 'Misc Payment CDG LABS INC', finalBusiness: true,
  });
  await out.update({ linkedTransactionId: arrival.id });

  const facts = await buildCorpFacts(ctx.entity.id, {
    startDate: '2025-01-01', endDate: '2025-12-31',
  });

  assert.equal(facts.activeBusinessIncome.length, 1, 'exactly one hop is revenue');
  // USD 5,000 at 1.40 = CAD 7,000 — the same money as hop 3, counted once.
  assert.equal(facts.activeBusinessIncome[0].cadAmount.toFixed(2), '7000.00');
  assert.deepEqual(facts.factWarnings ?? [], [], 'a named external payer needs no warning');
});

test('an orphaned arrival leg is counted but warned about', async () => {
  const ctx = await seedPerimeterCorp();
  // No upstream hops exist (the source account was never imported), so this
  // looks external. Count it, but say so.
  await seedTxn(ctx, ctx.chequing, {
    date: '2025-06-30', amount: '14891.9900', txnType: 'income',
    merchantRaw: 'Direct deposit from CDG LABS INC', finalBusiness: false,
  });

  const facts = await buildCorpFacts(ctx.entity.id, {
    startDate: '2025-01-01', endDate: '2025-12-31',
  });

  assert.equal(facts.activeBusinessIncome.length, 1);
  assert.equal(facts.activeBusinessIncome[0].cadAmount.toFixed(2), '14891.99');
  assert.equal((facts.factWarnings ?? []).length, 1);
  assert.match((facts.factWarnings ?? [])[0], /no external counterparty/);
});

test('business expenses exclude transfers and securities purchases', async () => {
  const ctx = await seedPerimeterCorp();
  await seedTxn(ctx, ctx.chequing, {
    date: '2025-04-01', amount: '10000.0000', txnType: 'income',
    merchantRaw: 'ACME CORP invoice 12', finalBusiness: false,
  });
  await seedTxn(ctx, ctx.chequing, {
    date: '2025-04-02', amount: '-6.0000', txnType: 'fee',
    merchantRaw: 'Account fee', finalBusiness: true,
  });
  // Capital deployment, not a cost of doing business.
  await seedTxn(ctx, ctx.chequing, {
    date: '2025-04-03', amount: '-9999.4100', txnType: 'investment',
    merchantRaw: 'Buy VFV', finalBusiness: false,
  });

  const facts = await buildCorpFacts(ctx.entity.id, {
    startDate: '2025-01-01', endDate: '2025-12-31',
  });

  const net = facts.activeBusinessIncome.reduce(
    (acc, i) => acc.plus(i.cadAmount), D(0),
  );
  assert.equal(net.toFixed(2), '9994.00', 'revenue 10000 less the 6.00 fee only');
});

test('corp chequing interest lands in investment income', async () => {
  const ctx = await seedPerimeterCorp();
  // Wealthsimple pays interest on the business chequing balance monthly.
  // There is no InvestmentActivity row for a chequing account, so before the
  // perimeter split routed these the income was reported nowhere.
  for (const [date, amount] of [
    ['2025-05-01', '2.2700'],
    ['2025-06-01', '17.7900'],
    ['2025-07-01', '30.9100'],
    ['2025-08-01', '27.5300'],
  ]) {
    await seedTxn(ctx, ctx.chequing, {
      date, amount, txnType: 'interest',
      merchantRaw: 'Interest received', finalBusiness: false,
    });
  }

  const facts = await buildCorpFacts(ctx.entity.id, {
    startDate: '2025-01-01', endDate: '2025-12-31',
  });

  assert.equal(facts.activeBusinessIncome.length, 0, 'interest is passive, not ABI');
  const interest = facts.investmentIncome.interest.reduce(
    (acc, i) => acc.plus(i.cadAmount), D(0),
  );
  assert.equal(interest.toFixed(2), '78.50');
});

test('passive transactions on an investment account do not double the ledger', async () => {
  const ctx = await seedPerimeterCorp();
  const investing = await Account.create({
    name: 'Corp Investing', householdId: ctx.household.id, accountType: 'investment',
    entityId: ctx.entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  // The brokerage restates each distribution as a cash transaction. The
  // InvestmentActivity ledger is the source of truth there (it carries the
  // security, and therefore the eligibility), so this row must be ignored.
  await seedTxn(ctx, investing, {
    date: '2025-03-31', amount: '151.2300', txnType: 'dividend',
    merchantRaw: 'XEQT cash dividend distribution', finalBusiness: false,
  });

  const facts = await buildCorpFacts(ctx.entity.id, {
    startDate: '2025-01-01', endDate: '2025-12-31',
  });

  assert.deepEqual(facts.investmentIncome.eligibleDividends, []);
  assert.deepEqual(facts.investmentIncome.nonEligibleDividends, []);
  assert.deepEqual(facts.investmentIncome.interest, []);
});

// --- business expenses fronted on a personal card ---
//
// Connor pays hosting/AI/internet on a personal Amex and the corp reimburses
// him. The cost is the corp's, but the transaction lives on a personal account,
// so buildCorpFacts (which queries corp-entity rows) never saw it — the corp
// deducted $30 for 2026 while the real costs sat on the personal card. The
// reimbursement transfer itself is NOT the deduction; the purchase is.

async function seedOwnerExpenseHousehold() {
  const household = await Household.create({ name: 'Owner Expense HH' });
  const corp = await Entity.create({
    householdId: household.id, kind: 'corp', legalName: 'CDG LABS INC.',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const personal = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'Personal',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const corpChequing = await Account.create({
    name: 'Corp Chequing', householdId: household.id, accountType: 'checking',
    entityId: corp.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  const personalCard = await Account.create({
    name: 'Amex Reserve', householdId: household.id, accountType: 'credit_card',
    entityId: personal.id, taxStatus: 'n_a', defaultCurrency: 'CAD',
  } as never);
  return { household, corp, personal, corpChequing, personalCard };
}

let oeFp = 0;
async function seedOwnerTxn(
  household: { id: number }, entityId: number, account: { id: number },
  over: Record<string, unknown>,
) {
  oeFp += 1;
  const merchantRaw = String(over.merchantRaw ?? 'VENDOR');
  return Transaction.create({
    accountId: account.id, householdId: household.id, entityId,
    currency: 'CAD', importBatch: 'test-owner-expense',
    merchantClean: merchantRaw,
    sourceRowFingerprint: `fp-oe-${oeFp}`,
    sourceIdentityFingerprint: `sif-oe-${oeFp}`,
    ...over,
    merchantRaw,
  } as never);
}

test('business spend on a personal card is deducted by the corp', async () => {
  const ctx = await seedOwnerExpenseHousehold();
  await seedOwnerTxn(ctx.household, ctx.corp.id, ctx.corpChequing, {
    date: '2025-04-01', amount: '10000.0000', txnType: 'income',
    merchantRaw: 'ACME CORP invoice',
  });
  await seedOwnerTxn(ctx.household, ctx.personal.id, ctx.personalCard, {
    date: '2025-05-02', amount: '-1758.3100', finalBusiness: true,
    finalCategory: 'Internet', merchantRaw: 'BELL CANADA',
  });
  await seedOwnerTxn(ctx.household, ctx.personal.id, ctx.personalCard, {
    date: '2025-06-02', amount: '-740.5300', finalBusiness: true,
    finalCategory: 'Ai', merchantRaw: 'ANTHROPIC',
  });

  const facts = await buildCorpFacts(ctx.corp.id, {
    startDate: '2025-01-01', endDate: '2025-12-31',
  });

  const net = facts.activeBusinessIncome.reduce((a, i) => a.plus(i.cadAmount), D(0));
  assert.equal(net.toFixed(2), '7501.16', '10000 revenue less 2498.84 of owner-paid costs');
  assert.ok(
    (facts.factWarnings ?? []).some((w) => /personal/i.test(w) && /2498\.84/.test(w)),
    `expected a warning naming the owner-paid total, got ${JSON.stringify(facts.factWarnings)}`,
  );
});

test('personal spend not flagged business is left alone', async () => {
  const ctx = await seedOwnerExpenseHousehold();
  await seedOwnerTxn(ctx.household, ctx.personal.id, ctx.personalCard, {
    date: '2025-05-02', amount: '-250.0000', finalBusiness: false,
    merchantRaw: 'GROCERIES',
  });

  const facts = await buildCorpFacts(ctx.corp.id, {
    startDate: '2025-01-01', endDate: '2025-12-31',
  });
  assert.deepEqual(facts.activeBusinessIncome, []);
});

test('a business-flagged personal INFLOW is not negative corp revenue', async () => {
  // A refund or a reimbursement landing back on the card is not a cost.
  const ctx = await seedOwnerExpenseHousehold();
  await seedOwnerTxn(ctx.household, ctx.personal.id, ctx.personalCard, {
    date: '2025-05-02', amount: '500.0000', finalBusiness: true,
    merchantRaw: 'REFUND',
  });

  const facts = await buildCorpFacts(ctx.corp.id, {
    startDate: '2025-01-01', endDate: '2025-12-31',
  });
  assert.deepEqual(facts.activeBusinessIncome, []);
});

test('card payments and transfers flagged business are not costs', async () => {
  const ctx = await seedOwnerExpenseHousehold();
  for (const txnType of ['payment', 'transfer', 'investment']) {
    await seedOwnerTxn(ctx.household, ctx.personal.id, ctx.personalCard, {
      date: '2025-05-02', amount: '-900.0000', finalBusiness: true, txnType,
      merchantRaw: `${txnType} row`,
    });
  }

  const facts = await buildCorpFacts(ctx.corp.id, {
    startDate: '2025-01-01', endDate: '2025-12-31',
  });
  assert.deepEqual(facts.activeBusinessIncome, []);
});

test('with two corps in the household the owner-paid pass is skipped, and says so', async () => {
  // Nothing in the data says WHICH corp a personal business expense belongs to,
  // and guessing would let the same dollar be deducted on two returns.
  const ctx = await seedOwnerExpenseHousehold();
  await Entity.create({
    householdId: ctx.household.id, kind: 'corp', legalName: 'Second Co.',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  await seedOwnerTxn(ctx.household, ctx.personal.id, ctx.personalCard, {
    date: '2025-05-02', amount: '-1758.3100', finalBusiness: true,
    merchantRaw: 'BELL CANADA',
  });

  const facts = await buildCorpFacts(ctx.corp.id, {
    startDate: '2025-01-01', endDate: '2025-12-31',
  });
  assert.deepEqual(facts.activeBusinessIncome, [], 'not attributed to either corp');
  assert.ok(
    (facts.factWarnings ?? []).some((w) => /more than one corporation/i.test(w)),
    `expected a multi-corp warning, got ${JSON.stringify(facts.factWarnings)}`,
  );
});
