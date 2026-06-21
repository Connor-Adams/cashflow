import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from './util/decimal';
import { buildT2 } from './engine/t2';
import { ratesFor } from './engine/brackets';
import type { CorpTaxYearFacts } from './engine/types';

const r = ratesFor(2024);

function baseFacts(): CorpTaxYearFacts {
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
    carryforwards: {
      grip: D('0'),
      cda: D('0'),
      erdtoh: D('0'),
      nerdtoh: D('0'),
      nonCapLoss: D('0'),
      netCapitalLoss: D('0'),
    },
  };
}

// -------------------------------------------------------------------
// Scenario A: Pure active income $300k — SBD on all, no grind, no investment tax
// -------------------------------------------------------------------
test('Scenario A: $300k ABI, no investment income', () => {
  const facts: CorpTaxYearFacts = {
    ...baseFacts(),
    activeBusinessIncome: [{ source: 'consulting', amount: D('300000'), cadAmount: D('300000') }],
  };

  const ret = buildT2(facts, r);

  assert.equal(ret.totals.activeBusinessIncome.toFixed(2), '300000.00');
  assert.equal(ret.totals.sbdEligibleIncome.toFixed(2), '300000.00');   // all SBD
  assert.equal(ret.totals.generalRateIncome.toFixed(2), '0.00');         // nothing at general rate
  assert.equal(ret.totals.aii.toFixed(2), '0.00');                       // no investment income

  // Federal: 300000 × 0.09 = 27000
  assert.equal(ret.totals.federalTax.toFixed(2), '27000.00');
  // ON: 300000 × 0.032 = 9600
  assert.equal(ret.totals.provincialTax.toFixed(2), '9600.00');

  // No investment income → no refundable tax
  assert.equal(ret.totals.refundableTaxOnAii.toFixed(2), '0.00');
  // No dividends paid → no refund
  assert.equal(ret.totals.dividendRefund.toFixed(2), '0.00');
  // Net = 27000 + 9600 = 36600
  assert.equal(ret.totals.netTaxPayable.toFixed(2), '36600.00');
});

// -------------------------------------------------------------------
// Scenario B: $600k ABI, no AAII — $500k SBD + $100k general rate
// -------------------------------------------------------------------
test('Scenario B: $600k ABI, no AAII grind', () => {
  const facts: CorpTaxYearFacts = {
    ...baseFacts(),
    activeBusinessIncome: [{ source: 'services', amount: D('600000'), cadAmount: D('600000') }],
  };

  const ret = buildT2(facts, r);

  assert.equal(ret.totals.sbdEligibleIncome.toFixed(2), '500000.00');
  assert.equal(ret.totals.generalRateIncome.toFixed(2), '100000.00');
  assert.equal(ret.totals.aii.toFixed(2), '0.00');

  // Federal: 500000×0.09 + 100000×0.15 = 45000 + 15000 = 60000
  assert.equal(ret.totals.federalTax.toFixed(2), '60000.00');
  // ON: 500000×0.032 + 100000×0.115 = 16000 + 11500 = 27500
  assert.equal(ret.totals.provincialTax.toFixed(2), '27500.00');
  assert.equal(ret.totals.netTaxPayable.toFixed(2), '87500.00');
});

// -------------------------------------------------------------------
// Scenario C: $400k ABI + $80k AAII → $350k SBD limit, $350k SBD + $50k general
// -------------------------------------------------------------------
test('Scenario C: $400k ABI + $80k AAII, grind reduces SBD limit to $350k', () => {
  const facts: CorpTaxYearFacts = {
    ...baseFacts(),
    activeBusinessIncome: [{ source: 'services', amount: D('400000'), cadAmount: D('400000') }],
    investmentIncome: {
      ...baseFacts().investmentIncome,
      interest: [{ source: 'bonds', amount: D('80000'), cadAmount: D('80000') }],
    },
  };

  const ret = buildT2(facts, r);

  // AAII = 80000
  assert.equal(ret.totals.aii.toFixed(2), '80000.00');
  // grind = (80k - 50k) × 5 = 150k; limit = 500k - 150k = 350k
  // eligible = min(400k, 350k) = 350k; general = 50k
  assert.equal(ret.totals.sbdEligibleIncome.toFixed(2), '350000.00');
  assert.equal(ret.totals.generalRateIncome.toFixed(2), '50000.00');

  // Federal: 350000×0.09 + 50000×0.15 + 80000×0.387
  //        = 31500 + 7500 + 30960 = 69960
  assert.equal(ret.totals.federalTax.toFixed(2), '69960.00');
  // ON: 350000×0.032 + 50000×0.115 + 80000×0.115
  //   = 11200 + 5750 + 9200 = 26150
  assert.equal(ret.totals.provincialTax.toFixed(2), '26150.00');

  // Refundable on AII: 80000 × 0.1067 = 8536
  assert.equal(ret.totals.refundableTaxOnAii.toFixed(2), '8536.00');
});

// -------------------------------------------------------------------
// Scenario D: Mixed $200k ABI + $40k interest + $20k eligible dividends paid
// -------------------------------------------------------------------
test('Scenario D: $200k ABI + $40k interest; $20k eligible dividends paid → SBD + ERDTOH + refund', () => {
  const facts: CorpTaxYearFacts = {
    ...baseFacts(),
    activeBusinessIncome: [{ source: 'consulting', amount: D('200000'), cadAmount: D('200000') }],
    investmentIncome: {
      ...baseFacts().investmentIncome,
      interest: [{ source: 'GIC', amount: D('40000'), cadAmount: D('40000') }],
    },
    dividendsPaid: [
      { source: 'corp', date: '2024-09-15', amount: D('20000'), kind: 'eligible' },
    ],
    carryforwards: {
      ...baseFacts().carryforwards,
      erdtoh: D('2000'), // small carryforward
    },
  };

  const ret = buildT2(facts, r);

  // ABI $200k < $500k limit, AAII = $40k < $50k threshold → no grind
  assert.equal(ret.totals.aii.toFixed(2), '40000.00');
  assert.equal(ret.totals.sbdEligibleIncome.toFixed(2), '200000.00');
  assert.equal(ret.totals.generalRateIncome.toFixed(2), '0.00');

  // Interest is refundable Part I tax → NERDTOH (30.67%), NOT ERDTOH:
  // NERDTOH addition: 40000 × 0.3067 = 12268; ERDTOH addition: 0
  // Eligible dividends paid only draw on ERDTOH: refund = min(20000 × 0.3833,
  // erdtoh carryforward 2000 + 0) = 2000
  assert.equal(ret.totals.dividendRefund.toFixed(4), '2000.0000');

  // Net tax payable must be positive (taxes > refund)
  assert.ok(ret.totals.netTaxPayable.greaterThan(D('0')));

  // GRIP ending: 0 (no general-rate income) − dividends paid = negative → clamped to 0
  assert.equal(ret.totals.gripEnding.toFixed(2), '0.00');

  // ERDTOH ending: (2000 + 0) − 2000 refund = 0
  assert.equal(ret.totals.erdtohEnding.toFixed(4), '0.0000');
  // NERDTOH ending: untouched by the eligible-dividend refund = 12268
  assert.equal(ret.totals.nerdtohEnding.toFixed(4), '12268.0000');
});

// -------------------------------------------------------------------
// Scenario D2: dividend refund draws each pool separately
// -------------------------------------------------------------------
test('Scenario D2: eligible refund reduces ERDTOH and non-eligible refund reduces NERDTOH', () => {
  const facts: CorpTaxYearFacts = {
    ...baseFacts(),
    dividendsPaid: [
      { source: 'corp', date: '2024-09-15', amount: D('4000'), kind: 'eligible' },
      { source: 'corp', date: '2024-09-15', amount: D('4000'), kind: 'non_eligible' },
    ],
    carryforwards: {
      ...baseFacts().carryforwards,
      erdtoh: D('10000'),
      nerdtoh: D('5000'),
    },
  };

  const ret = buildT2(facts, r);

  // refundEligible = min(4000 × 0.3833, 10000) = 1533.20
  // refundNonEligible = min(4000 × 0.3833, 5000) = 1533.20
  assert.equal(ret.totals.dividendRefund.toFixed(4), '3066.4000');
  // Each pool is reduced only by its own refund:
  assert.equal(ret.totals.erdtohEnding.toFixed(4), '8466.8000');
  assert.equal(ret.totals.nerdtohEnding.toFixed(4), '3466.8000');
});

// -------------------------------------------------------------------
// Scenario E (P11b): groupAaii override drives SBD grind
//   ABI = $400k, per-corp AAII = $0, groupAaii = $100k
//   → grind = ($100k - $50k) × $5 = $250k off limit
//   → SBD limit = $500k - $250k = $250k
//   → SBD eligible = min($400k, $250k) = $250k
//   → general rate = $400k - $250k = $150k
// -------------------------------------------------------------------
test('Scenario E (P11b): groupAaii override applied to SBD grind', () => {
  const facts: CorpTaxYearFacts = {
    ...baseFacts(),
    activeBusinessIncome: [{ source: 'services', amount: D('400000'), cadAmount: D('400000') }],
    groupAaii: D('100000'),
  };

  const ret = buildT2(facts, r);

  // Per-corp AAII still reported on L417 (== 0, no investment income here)
  assert.equal(ret.totals.aii.toFixed(2), '0.00');

  // SBD limit ground from $500k → $250k by group AAII; ABI $400k → SBD $250k, general $150k
  assert.equal(ret.totals.sbdEligibleIncome.toFixed(2), '250000.00');
  assert.equal(ret.totals.generalRateIncome.toFixed(2), '150000.00');

  // Engine trace: when groupAaii is supplied, an extra line L417G surfaces it
  const codes = ret.lines.map(l => l.code);
  assert.ok(codes.includes('L417G'), 'Expected L417G line when groupAaii present');
  const l417g = ret.lines.find(l => l.code === 'L417G')!;
  assert.equal(l417g.amount.toFixed(2), '100000.00');
});

// -------------------------------------------------------------------
// Scenario F (P11b T6): openingGripBoost adds to GRIP ending
//   Pure holdco: $0 ABI, $0 general-rate income (so no own GRIP growth),
//   priorGrip = $10,000, openingGripBoost = $50,000 (injected by
//   computeHouseholdPlan from intercorpRouter.gripBoost), $0 dividends paid.
//   Expected: gripEnding = priorGrip + gripAddition + openingGripBoost
//                        = 10000 + 0          + 50000 = 60000
// -------------------------------------------------------------------
test('Scenario F (P11b T6): openingGripBoost adds to GRIP ending', () => {
  const facts: CorpTaxYearFacts = {
    ...baseFacts(),
    carryforwards: {
      ...baseFacts().carryforwards,
      grip: D('10000'),
    },
    openingGripBoost: D('50000'),
  };

  const ret = buildT2(facts, r);

  // No own general-rate income → integration.gripAddition = 0
  // gripEnding = 10000 (prior) + 0 (own growth) + 50000 (boost) − 0 (paid) = 60000
  assert.equal(ret.totals.gripEnding.toFixed(2), '60000.00');

  // L500B surfaces only when boost > 0
  const codes = ret.lines.map((l) => l.code);
  assert.ok(codes.includes('L500B'), 'Expected L500B line when openingGripBoost present');
  const l500b = ret.lines.find((l) => l.code === 'L500B')!;
  assert.equal(l500b.amount.toFixed(2), '50000.00');
});

test('Scenario F2 (P11b T6): omitting openingGripBoost is a no-op (backwards compat)', () => {
  // Same facts as Scenario A — should produce identical gripEnding (0 here)
  // and NOT surface L500B.
  const facts: CorpTaxYearFacts = {
    ...baseFacts(),
    activeBusinessIncome: [{ source: 'consulting', amount: D('300000'), cadAmount: D('300000') }],
  };
  const ret = buildT2(facts, r);
  // 300k SBD income → general rate = 0 → gripAddition = 0; priorGrip = 0; boost absent
  assert.equal(ret.totals.gripEnding.toFixed(2), '0.00');
  const codes = ret.lines.map((l) => l.code);
  assert.ok(!codes.includes('L500B'), 'L500B must not appear when openingGripBoost is omitted');
});

// -------------------------------------------------------------------
// Bonus: losses reduce taxable income to zero
// -------------------------------------------------------------------
test('Carryforward losses can reduce taxable income to zero (not negative)', () => {
  const facts: CorpTaxYearFacts = {
    ...baseFacts(),
    activeBusinessIncome: [{ source: 'consulting', amount: D('100000'), cadAmount: D('100000') }],
    carryforwards: {
      ...baseFacts().carryforwards,
      nonCapLoss: D('200000'), // larger loss than income
    },
  };

  const ret = buildT2(facts, r);
  // Taxable income = max(0, 100000 - 200000) = 0
  assert.equal(ret.totals.taxableIncome.toFixed(2), '0.00');
  // Zero taxable income → zero tax (the loss must flow into the tax calc,
  // not just the taxable-income line)
  assert.equal(ret.totals.federalTax.toFixed(2), '0.00');
  assert.equal(ret.totals.provincialTax.toFixed(2), '0.00');
  assert.equal(ret.totals.netTaxPayable.toFixed(2), '0.00');
  assert.equal(ret.totals.refundableTaxOnAii.toFixed(2), '0.00');
});

test('Non-capital loss displaces general-rate income before SBD income', () => {
  // $600k ABI → $500k SBD + $100k general; $150k loss reduces taxable income
  // to $450k. SBD = least of (ABI, taxable income, limit) = $450k; the general
  // pool absorbs the loss first, then SBD shrinks.
  const facts: CorpTaxYearFacts = {
    ...baseFacts(),
    activeBusinessIncome: [{ source: 'services', amount: D('600000'), cadAmount: D('600000') }],
    carryforwards: {
      ...baseFacts().carryforwards,
      nonCapLoss: D('150000'),
    },
  };

  const ret = buildT2(facts, r);
  assert.equal(ret.totals.taxableIncome.toFixed(2), '450000.00');
  // Federal: 450000 × 0.09 = 40500 (nothing left at the general rate)
  assert.equal(ret.totals.federalTax.toFixed(2), '40500.00');
  // ON: 450000 × 0.032 = 14400
  assert.equal(ret.totals.provincialTax.toFixed(2), '14400.00');
});

test('Net capital loss carryforward only offsets taxable capital gains, not ABI', () => {
  const facts: CorpTaxYearFacts = {
    ...baseFacts(),
    activeBusinessIncome: [{ source: 'consulting', amount: D('100000'), cadAmount: D('100000') }],
    capitalGainEvents: [
      // gross gain 30000 → taxable 30000 × 0.666667 = 20000.01
      { source: 'stock', securityId: 1, proceeds: D('30000'), acb: D('0'), outlays: D('0'), date: '2024-06-01' },
    ],
    carryforwards: {
      ...baseFacts().carryforwards,
      netCapitalLoss: D('50000'), // exceeds the gains — must NOT touch ABI
    },
  };

  const ret = buildT2(facts, r);
  // Net capital loss applied = min(50000, 20000.01) = 20000.01 → taxable
  // income = 100000 (the excess loss cannot shelter active business income)
  assert.equal(ret.totals.taxableIncome.toFixed(2), '100000.00');
  // All remaining income is SBD-rate ABI: 100000 × 0.09 / × 0.032
  assert.equal(ret.totals.federalTax.toFixed(2), '9000.00');
  assert.equal(ret.totals.provincialTax.toFixed(2), '3200.00');
  // Gains fully sheltered → no refundable tax on AII
  assert.equal(ret.totals.refundableTaxOnAii.toFixed(2), '0.00');
});

test('Refundable Part I tax base (L450) includes taxable capital gains', () => {
  const facts: CorpTaxYearFacts = {
    ...baseFacts(),
    investmentIncome: {
      ...baseFacts().investmentIncome,
      interest: [{ source: 'GIC', amount: D('10000'), cadAmount: D('10000') }],
    },
    capitalGainEvents: [
      // gross gain 30000 → taxable 30000 × 0.666667 = 20000.01
      { source: 'stock', securityId: 1, proceeds: D('30000'), acb: D('0'), outlays: D('0'), date: '2024-06-01' },
    ],
  };

  const ret = buildT2(facts, r);
  // Refundable AII base = interest 10000 + taxable gains 20000.01 = 30000.01
  // × 0.1067 = 3201.001067
  assert.equal(ret.totals.refundableTaxOnAii.toFixed(2), '3201.00');
});

// -------------------------------------------------------------------
// Bonus: line codes present
// -------------------------------------------------------------------
test('T2 return includes expected line codes', () => {
  const facts: CorpTaxYearFacts = {
    ...baseFacts(),
    activeBusinessIncome: [{ source: 'svc', amount: D('100000'), cadAmount: D('100000') }],
  };

  const ret = buildT2(facts, r);
  const codes = ret.lines.map(l => l.code);

  for (const code of ['L300', 'L417', 'L425', 'L427', 'L430', 'L440', 'L445', 'L300T', 'L700F', 'L700P', 'L450', 'L500', 'L501', 'L502', 'L503', 'L780', 'L770']) {
    assert.ok(codes.includes(code), `Missing line code ${code}`);
  }
});

// -------------------------------------------------------------------
// s.112: intercorporate dividends are deducted from taxable income
// -------------------------------------------------------------------
test('s.112: connected intercorp dividends bear no Part I tax; portfolio dividends still do', () => {
  const facts: CorpTaxYearFacts = {
    ...baseFacts(),
    investmentIncome: {
      interest: [],
      eligibleDividends: [
        { source: 'intercorpRouter:from-corp-42:eligible', amount: D('50000'), cadAmount: D('50000') },
        { source: 'BCE shares', amount: D('10000'), cadAmount: D('10000') },
      ],
      nonEligibleDividends: [
        { source: 'intercorpRouter:from-corp-42:nonEligible', amount: D('15000'), cadAmount: D('15000') },
      ],
      rentNet: [],
    },
  };

  const ret = buildT2(facts, r);

  // Only the $10k portfolio dividend is taxable; the $65k connected dividends
  // are deductible under s.112(1) (they are Part IV territory instead).
  assert.equal(ret.totals.taxableIncome.toFixed(2), '10000.00');
  assert.equal(ret.totals.federalTax.toFixed(2), '3870.00', '10000 × 0.387 investment rate');
  assert.equal(ret.totals.provincialTax.toFixed(2), '1150.00', '10000 × 0.115');
  const l320 = ret.lines.find(l => l.code === 'L320');
  assert.ok(l320, 'expected the s.112 deduction line');
  assert.equal(l320!.amount.toFixed(2), '65000.00');
});

test('s.112: a pure holdco receiving only intercorp dividends owes zero Part I tax', () => {
  const facts: CorpTaxYearFacts = {
    ...baseFacts(),
    investmentIncome: {
      interest: [],
      eligibleDividends: [
        { source: 'intercorpRouter:from-corp-7:eligible', amount: D('100000'), cadAmount: D('100000') },
      ],
      nonEligibleDividends: [],
      rentNet: [],
    },
  };

  const ret = buildT2(facts, r);
  assert.equal(ret.totals.taxableIncome.toFixed(2), '0.00');
  assert.equal(ret.totals.federalTax.toFixed(2), '0.00');
  assert.equal(ret.totals.provincialTax.toFixed(2), '0.00');
  assert.equal(ret.totals.netTaxPayable.toFixed(2), '0.00');
});

// -------------------------------------------------------------------
// GRIP addition: statutory 0.72 factor on POST-loss general-rate income
// -------------------------------------------------------------------
test('GRIP addition uses post-loss general-rate income at the statutory 0.72 factor', () => {
  // $600k ABI → $500k SBD + $100k general-rate. A $60k non-capital loss CF
  // displaces general-rate income first (TI 540k − 500k SBD = 40k general).
  // GRIP addition = 0.72 × 40,000 = 28,800 — NOT 0.72 × 100,000 (pre-loss),
  // and NOT 0.735 (the old combined-rate derivation).
  const facts: CorpTaxYearFacts = {
    ...baseFacts(),
    activeBusinessIncome: [{ source: 'ops', amount: D('600000'), cadAmount: D('600000') }],
    carryforwards: {
      ...baseFacts().carryforwards,
      nonCapLoss: D('60000'),
    },
  };

  const ret = buildT2(facts, r);
  assert.equal(ret.totals.taxableIncome.toFixed(2), '540000.00');
  assert.equal(ret.totals.gripEnding.toFixed(2), '28800.00', '0.72 × post-loss 40k general-rate income');
});

// -------------------------------------------------------------------
// s.129(1) pool draws: ERDTOH overflow reduces ERDTOH, not NERDTOH
// -------------------------------------------------------------------
test('s.129(1): ERDTOH overflow for a non-eligible refund reduces the ERDTOH ending balance', () => {
  const facts: CorpTaxYearFacts = {
    ...baseFacts(),
    dividendsPaid: [
      { source: 'corp', date: '2024-11-01', amount: D('10000'), kind: 'non_eligible' },
    ],
    carryforwards: {
      ...baseFacts().carryforwards,
      erdtoh: D('10000'),
      nerdtoh: D('1000'),
    },
  };

  const ret = buildT2(facts, r);
  // Gross refund 3833: 1000 from NERDTOH (exhausted), 2833 overflow from ERDTOH.
  assert.equal(ret.totals.dividendRefund.toFixed(4), '3833.0000');
  assert.equal(ret.totals.nerdtohEnding.toFixed(4), '0.0000');
  assert.equal(ret.totals.erdtohEnding.toFixed(4), '7167.0000', '10000 − 2833 overflow');
});
