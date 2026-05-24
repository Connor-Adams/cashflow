import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../../src/tax/util/decimal';
import { ratesFor } from '../../src/tax/engine/brackets';
import { runScenario } from '../../src/tax/engine/scenario';
import type { ScenarioInput, CorpTaxYearFacts } from '../../src/tax/engine/types';

const r = ratesFor(2024);

const emptyCorpCarryforwards = {
  grip: D('0'),
  cda: D('0'),
  erdtoh: D('0'),
  nerdtoh: D('0'),
  nonCapLoss: D('0'),
  netCapitalLoss: D('0'),
};

const emptyPersonalCarryforwards = {
  netCapitalLoss: D('0'),
  rrspRoom: D('0'),
  nonCapLoss: D('0'),
  instalmentsPaid: D('0'),
};

function baseCorpFacts(): CorpTaxYearFacts {
  return {
    fiscalYear: { startDate: '2024-01-01', endDate: '2024-12-31' },
    jurisdiction: 'CA-ON',
    activeBusinessIncome: [],
    investmentIncome: {
      interest: [],
      eligibleDividends: [],
      nonEligibleDividends: [],
      rentNet: [],
    },
    capitalGainEvents: [],
    dividendsPaid: [],
    salaryPaid: D('0'),
    carryforwards: { ...emptyCorpCarryforwards },
  };
}

function basePersonalFacts(): ScenarioInput['personalFactsBase'] {
  return {
    year: 2024,
    jurisdiction: 'CA-ON' as const,
    selfEmploymentIncome: [],
    selfEmploymentExpenses: [],
    interestIncome: [],
    capitalGainEvents: [],
    rrspContribs: [],
    fhsaContribs: [],
    donations: [],
    slips: [],
    carryforwards: { ...emptyPersonalCarryforwards },
    ageAtYearEnd: 40,
    employmentIncomeBase: [],
    eligibleDividendsBase: [],
    nonEligibleDividendsBase: [],
  };
}

// ---------------------------------------------------------------------------
// Scenario 1: All-salary — $100k salary, $0 dividends
// Corp deducts salary as ABI reduction; personal pays employment + CPP/EI.
// ---------------------------------------------------------------------------
test('Scenario 1: all-salary $100k — corp deducts salary, personal pays employment tax', () => {
  const corpFacts = baseCorpFacts();
  // Corp has $200k ABI before salary deduction
  corpFacts.activeBusinessIncome = [
    { source: 'consulting', amount: D('200000'), cadAmount: D('200000') },
  ];

  const input: ScenarioInput = {
    year: 2024,
    jurisdiction: 'CA-ON',
    personalFactsBase: {
      ...basePersonalFacts(),
    },
    corpFactsBase: corpFacts,
    ownerComp: {
      salary: D('100000'),
      eligibleDividends: D('0'),
      nonEligibleDividends: D('0'),
    },
  };

  const result = runScenario(input, r);

  // Corp: ABI was 200k, salary deduction of 100k → net ABI = 100k
  assert.equal(result.corpReturn.totals.activeBusinessIncome.toFixed(2), '100000.00',
    'Corp ABI net should be $100k after $100k salary deduction');

  // Corp tax on $100k SBD: 100k × (9% + 3.2%) = 12200
  assert.equal(result.corpReturn.totals.netTaxPayable.toFixed(2), '12200.00',
    'Corp should pay SBD rate on $100k ABI');

  // No dividends paid → no dividend refund
  assert.equal(result.corpReturn.totals.dividendRefund.toFixed(2), '0.00');

  // Personal: $100k employment income
  assert.equal(result.personalReturn.totals.totalIncome.toFixed(2), '100000.00',
    'Personal total income = $100k salary');

  // Personal pays employment tax + CPP + EI (should be substantial at 100k)
  assert.ok(result.personalReturn.totals.totalPayable.greaterThan(D('25000')),
    'Personal tax at $100k employment should exceed $25k');
  assert.ok(result.personalReturn.totals.cppContrib.greaterThan(D('0')),
    'CPP contribution should be > 0 on salary');
  assert.ok(result.personalReturn.totals.eiPremium.greaterThan(D('0')),
    'EI premium should be > 0 on salary');

  // Household total tax = corp + personal
  const expected = result.corpReturn.totals.netTaxPayable.plus(result.personalReturn.totals.totalPayable);
  assert.equal(result.combinedTotals.householdTotalTax.toFixed(2), expected.toFixed(2));

  // Effective rate should be reasonable on $200k gross (corp $12.2k + personal ~$25-30k → ~18-21%)
  assert.ok(result.combinedTotals.effectiveRate.greaterThan(D('0.15')),
    'Effective rate > 15% on all-salary scenario');
  assert.ok(result.combinedTotals.effectiveRate.lessThan(D('0.50')),
    'Effective rate < 50% on all-salary scenario');
});

// ---------------------------------------------------------------------------
// Scenario 2: All-eligible-dividend — $0 salary, $100k eligible dividend
// Corp pays general rate on ABI; personal pays via gross-up + DTC; dividend refund.
// ---------------------------------------------------------------------------
test('Scenario 2: all-eligible-dividend $100k — corp refund, personal gross-up + DTC', () => {
  const corpFacts = baseCorpFacts();
  // Corp has $100k ABI, no salary → full amount available for dividend
  corpFacts.activeBusinessIncome = [
    { source: 'consulting', amount: D('100000'), cadAmount: D('100000') },
  ];

  const input: ScenarioInput = {
    year: 2024,
    jurisdiction: 'CA-ON',
    personalFactsBase: {
      ...basePersonalFacts(),
    },
    corpFactsBase: corpFacts,
    ownerComp: {
      salary: D('0'),
      eligibleDividends: D('100000'),
      nonEligibleDividends: D('0'),
    },
  };

  const result = runScenario(input, r);

  // Corp: ABI unchanged (no salary deduction), $100k at SBD rates
  assert.equal(result.corpReturn.totals.activeBusinessIncome.toFixed(2), '100000.00',
    'Corp ABI = $100k, no salary deduction');

  // Corp paid eligible dividend → GRIP addition increases, dividend refund may apply
  // (refund only if ERDTOH has balance; from SBD income there is none, so refund = 0)
  assert.equal(result.corpReturn.totals.dividendRefund.toFixed(2), '0.00',
    'No ERDTOH from SBD income → no dividend refund on eligible div');

  // Personal: $100k eligible dividend (grossed up at 38%)
  const grossedUp = D('100000').times('1.38');
  assert.equal(
    result.personalReturn.lines.find(l => l.code === 'L12000')?.amount.toFixed(2),
    grossedUp.toFixed(2),
    'L12000 should show grossed-up eligible dividend'
  );

  // Personal total income includes grossed-up dividend
  assert.ok(result.personalReturn.totals.totalIncome.greaterThanOrEqualTo(grossedUp),
    'Personal total income includes grossed-up dividend');

  // No employment income → no CPP or EI
  assert.equal(result.personalReturn.totals.cppContrib.toFixed(2), '0.00',
    'No CPP on dividend-only income');
  assert.equal(result.personalReturn.totals.eiPremium.toFixed(2), '0.00',
    'No EI on dividend-only income');

  // Dividend tax credit reduces personal tax meaningfully
  assert.ok(result.personalReturn.totals.totalPayable.lessThan(D('25000')),
    'Personal tax on $100k eligible dividends should be < $25k (DTC credit offsets gross-up)');
});

// ---------------------------------------------------------------------------
// Scenario 3: Mixed — $50k salary + $50k eligible dividend
// Verify combined outputs are reasonable interpolation between pure scenarios.
// ---------------------------------------------------------------------------
test('Scenario 3: mixed $50k salary + $50k eligible dividend', () => {
  const corpFacts = baseCorpFacts();
  // Corp starts with $200k ABI (generous so corp stays profitable after salary)
  corpFacts.activeBusinessIncome = [
    { source: 'consulting', amount: D('200000'), cadAmount: D('200000') },
  ];

  const input: ScenarioInput = {
    year: 2024,
    jurisdiction: 'CA-ON',
    personalFactsBase: {
      ...basePersonalFacts(),
    },
    corpFactsBase: corpFacts,
    ownerComp: {
      salary: D('50000'),
      eligibleDividends: D('50000'),
      nonEligibleDividends: D('0'),
    },
  };

  const result = runScenario(input, r);

  // Corp: 200k - 50k salary deduction = 150k net ABI
  assert.equal(result.corpReturn.totals.activeBusinessIncome.toFixed(2), '150000.00',
    'Corp ABI = $150k after $50k salary deduction');

  // Corp tax on $150k at SBD rate: 150k × 12.2% = 18300
  assert.equal(result.corpReturn.totals.netTaxPayable.toFixed(2), '18300.00',
    'Corp tax on $150k at SBD rate');

  // Personal has both employment ($50k) and eligible dividend ($50k grossed up)
  const expectedPersonalIncome = D('50000').plus(D('50000').times('1.38')); // 50k + 69k = 119k
  assert.ok(
    result.personalReturn.totals.totalIncome.greaterThanOrEqualTo(expectedPersonalIncome.minus(D('1'))),
    'Personal total income ≥ 50k salary + 69k grossed dividend'
  );

  // CPP contribution exists on salary portion
  assert.ok(result.personalReturn.totals.cppContrib.greaterThan(D('0')),
    'CPP contribution on $50k salary');

  // Combined household tax
  const householdTax = result.combinedTotals.householdTotalTax;
  assert.ok(householdTax.greaterThan(D('20000')),
    'Household total tax > $20k on mixed $100k comp from $200k corp');
  assert.ok(householdTax.lessThan(D('70000')),
    'Household total tax < $70k on mixed $100k comp from $200k corp');

  // personalAfterTaxIncome = personal total income - personal payable
  const expected = result.personalReturn.totals.totalIncome.minus(result.personalReturn.totals.totalPayable);
  assert.equal(
    result.combinedTotals.personalAfterTaxIncome.toFixed(2),
    expected.toFixed(2),
    'personalAfterTaxIncome = totalIncome - totalPayable'
  );
});

// ---------------------------------------------------------------------------
// Scenario 4: Zero comp — $0 salary, $0 dividends
// Verify corp pays tax on ABI, personal has no income, household = corp tax only.
// ---------------------------------------------------------------------------
test('Scenario 4: zero owner comp — household tax = corp tax only', () => {
  const corpFacts = baseCorpFacts();
  corpFacts.activeBusinessIncome = [
    { source: 'services', amount: D('100000'), cadAmount: D('100000') },
  ];

  const input: ScenarioInput = {
    year: 2024,
    jurisdiction: 'CA-ON',
    personalFactsBase: {
      ...basePersonalFacts(),
    },
    corpFactsBase: corpFacts,
    ownerComp: {
      salary: D('0'),
      eligibleDividends: D('0'),
      nonEligibleDividends: D('0'),
    },
  };

  const result = runScenario(input, r);

  // Corp tax: 100k × 12.2% = 12200
  assert.equal(result.corpReturn.totals.netTaxPayable.toFixed(2), '12200.00');

  // Personal: $0 income → $0 payable
  assert.equal(result.personalReturn.totals.totalPayable.toFixed(2), '0.00');

  // Household = just corp tax
  assert.equal(
    result.combinedTotals.householdTotalTax.toFixed(2),
    '12200.00',
    'Household tax = corp tax when zero comp'
  );
});
