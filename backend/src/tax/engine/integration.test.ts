import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal';
import { computeIntegration } from './integration';
import { ratesFor } from './brackets';
import type { CorpTaxYearFacts } from './types';

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

test('Integration: pure active income — CDA and RDTOH are zero', () => {
  // $100k general-rate ABI, no investment income, no cap gains, no dividends paid
  const integ = computeIntegration(baseFacts(), D('100000'), r);

  // GRIP addition: 100000 × (1 - 0.15 - 0.115) = 100000 × 0.735 = 73500
  assert.equal(integ.gripAddition.toFixed(2), '73500.00');

  // No cap gains → CDA = 0
  assert.equal(integ.cdaAddition.toFixed(2), '0.00');

  // No investment income → ERDTOH = 0
  assert.equal(integ.erdtohAddition.toFixed(2), '0.00');

  // No non-eligible divs received → NERDTOH = 0
  assert.equal(integ.nerdtohAddition.toFixed(2), '0.00');

  // No dividends paid → no refund
  assert.equal(integ.dividendRefund.toFixed(2), '0.00');
});

test('Integration: mixed active + investment income — GRIP, CDA, RDTOH additions computed', () => {
  const facts: CorpTaxYearFacts = {
    ...baseFacts(),
    investmentIncome: {
      interest: [{ source: 'GIC', amount: D('40000'), cadAmount: D('40000') }],
      eligibleDividends: [],
      nonEligibleDividends: [{ source: 'priv corp', amount: D('10000'), cadAmount: D('10000') }],
      rentNet: [{ source: 'rental', amount: D('20000'), cadAmount: D('20000') }],
    },
    capitalGainEvents: [
      { source: 'RE sale', securityId: 1, proceeds: D('150000'), acb: D('100000'), outlays: D('5000'), date: '2024-06-01' },
    ],
    dividendsPaid: [
      { source: 'corp', date: '2024-11-01', amount: D('30000'), kind: 'non_eligible' },
    ],
    carryforwards: {
      grip: D('0'),
      cda: D('0'),
      erdtoh: D('0'),
      nerdtoh: D('5000'),
      nonCapLoss: D('0'),
      netCapitalLoss: D('0'),
    },
  };

  const generalRateIncome = D('50000');
  const integ = computeIntegration(facts, generalRateIncome, r);

  // GRIP: 50000 × (1 - 0.15 - 0.115) = 50000 × 0.735 = 36750
  assert.equal(integ.gripAddition.toFixed(2), '36750.00');

  // CDA: gross cap gain = 150000 - 100000 - 5000 = 45000; non-taxable = 45000 × (1 - 0.666667) = 14999.985
  assert.equal(integ.cdaAddition.toFixed(2), '14999.98');

  // ERDTOH: Part IV tax on portfolio ELIGIBLE dividends only — none here → 0.
  // (Interest and rent are refundable Part I tax → NERDTOH, not ERDTOH.)
  assert.equal(integ.erdtohAddition.toFixed(4), '0.0000');

  // NERDTOH: refundable Part I tax on AII (interest 40000 + rent 20000 +
  // taxable gains 45000 × 0.666667 = 30000.015) × 0.3067 = 27603.0046005,
  // plus nonElDiv 10000 × 0.3067 = 3067 → 30670.0046005
  assert.equal(integ.nerdtohAddition.toFixed(4), '30670.0046');

  // Dividend refund: 30000 non-eligible paid × 0.3833 = 11499;
  // NERDTOH avail = 5000 + 30670.0046 = 35670.0046 → refund = 11499
  assert.equal(integ.dividendRefund.toFixed(4), '11499.0000');
  assert.equal(integ.refundForEligible.toFixed(4), '0.0000');
  assert.equal(integ.refundForNonEligible.toFixed(4), '11499.0000');
});

test('Integration: net capital loss carryforward shrinks the refundable AII (NERDTOH) base', () => {
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
    carryforwards: {
      ...baseFacts().carryforwards,
      netCapitalLoss: D('50000'), // only deductible against taxable gains
    },
  };

  const integ = computeIntegration(facts, D('0'), r);
  // Taxable gains fully absorbed by the loss carryforward (capped at gains);
  // AII base = interest 10000 + gains 0 → NERDTOH = 10000 × 0.3067 = 3067
  assert.equal(integ.nerdtohAddition.toFixed(4), '3067.0000');
  assert.equal(integ.erdtohAddition.toFixed(2), '0.00');
});

test('Integration: eligible dividend refund capped by ERDTOH balance', () => {
  const facts: CorpTaxYearFacts = {
    ...baseFacts(),
    dividendsPaid: [
      { source: 'corp', date: '2024-11-01', amount: D('100000'), kind: 'eligible' },
    ],
    carryforwards: {
      ...baseFacts().carryforwards,
      erdtoh: D('5000'), // small ERDTOH balance
    },
  };

  const integ = computeIntegration(facts, D('0'), r);

  // 100000 × 0.3833 = 38330; ERDTOH avail = 5000 + 0 = 5000 → refund capped at 5000
  assert.equal(integ.dividendRefund.toFixed(2), '5000.00');
});

test('Integration: cap losses do not produce negative CDA', () => {
  const facts: CorpTaxYearFacts = {
    ...baseFacts(),
    capitalGainEvents: [
      { source: 'stock', securityId: 1, proceeds: D('0'), acb: D('10000'), outlays: D('0'), date: '2024-06-01' },
    ],
  };

  const integ = computeIntegration(facts, D('0'), r);
  // grossGains = -10000; cdaAddition = maxZero(-10000) × (1 - 0.666667) = 0
  assert.equal(integ.cdaAddition.toFixed(2), '0.00');
});

test('P11b T5: connected intercorp dividend (source-tagged) excluded from ERDTOH/NERDTOH; portfolio div still attracts Part IV', () => {
  // Holdco receives:
  //   - $50,000 eligible div from Opco via intercorpRouter (CONNECTED → Part IV = 0 in v1)
  //   - $20,000 eligible div from a public-co portfolio holding (PORTFOLIO → 38.33% ERDTOH)
  //   - $15,000 non-eligible div from another holdco via intercorpRouter (CONNECTED → Part IV = 0 in v1)
  //   - $8,000 non-eligible div from a private-co minority stake (PORTFOLIO → 30.67% NERDTOH)
  const facts: CorpTaxYearFacts = {
    ...baseFacts(),
    investmentIncome: {
      interest: [],
      eligibleDividends: [
        { source: 'intercorpRouter:from-corp-42:eligible', amount: D('50000'), cadAmount: D('50000') },
        { source: 'BCE shares', amount: D('20000'), cadAmount: D('20000') },
      ],
      nonEligibleDividends: [
        { source: 'intercorpRouter:from-corp-99:nonEligible', amount: D('15000'), cadAmount: D('15000') },
        { source: 'minority stake', amount: D('8000'), cadAmount: D('8000') },
      ],
      rentNet: [],
    },
  };

  const integ = computeIntegration(facts, D('0'), r);

  // ERDTOH: only the $20k portfolio eligible div contributes (interest=0, rent=0)
  //   20000 × 0.3833 = 7666
  assert.equal(integ.erdtohAddition.toFixed(4), '7666.0000');
  // NERDTOH: only the $8k portfolio non-eligible div contributes
  //   8000 × 0.3067 = 2453.60
  assert.equal(integ.nerdtohAddition.toFixed(4), '2453.6000');
});

test('P11b T5: connected-only divs produce zero RDTOH addition (v1 simplification)', () => {
  // 100% intercorp eligible div, no portfolio — ERDTOH addition should be 0
  const facts: CorpTaxYearFacts = {
    ...baseFacts(),
    investmentIncome: {
      interest: [],
      eligibleDividends: [
        { source: 'intercorpRouter:from-corp-7:eligible', amount: D('100000'), cadAmount: D('100000') },
      ],
      nonEligibleDividends: [
        { source: 'intercorpRouter:from-corp-7:nonEligible', amount: D('40000'), cadAmount: D('40000') },
      ],
      rentNet: [],
    },
  };

  const integ = computeIntegration(facts, D('0'), r);
  assert.equal(integ.erdtohAddition.toFixed(2), '0.00');
  assert.equal(integ.nerdtohAddition.toFixed(2), '0.00');
});
