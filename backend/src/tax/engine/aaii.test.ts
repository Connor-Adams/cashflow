import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal';
import { computeAaii } from './aaii';
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

test('AAII: zero with no investment income', () => {
  const aaii = computeAaii(baseFacts(), r);
  assert.equal(aaii.toFixed(2), '0.00');
});

test('AAII: interest only', () => {
  const facts: CorpTaxYearFacts = {
    ...baseFacts(),
    investmentIncome: {
      ...baseFacts().investmentIncome,
      interest: [{ source: 'GIC', amount: D('30000'), cadAmount: D('30000') }],
    },
  };
  const aaii = computeAaii(facts, r);
  assert.equal(aaii.toFixed(2), '30000.00');
});

test('AAII: mixed interest + dividends + rent + capital gain', () => {
  const facts: CorpTaxYearFacts = {
    ...baseFacts(),
    investmentIncome: {
      interest: [{ source: 'bond', amount: D('10000'), cadAmount: D('10000') }],
      eligibleDividends: [{ source: 'public co', amount: D('5000'), cadAmount: D('5000') }],
      nonEligibleDividends: [{ source: 'private co', amount: D('2000'), cadAmount: D('2000') }],
      rentNet: [{ source: 'rental', amount: D('8000'), cadAmount: D('8000') }],
    },
    capitalGainEvents: [
      { source: 'stock', securityId: 1, proceeds: D('20000'), acb: D('10000'), outlays: D('0'), date: '2024-06-01' },
    ],
  };
  // interest(10k) + elDiv(5k) + nonElDiv(2k) + rent(8k) + gain(10k)×0.666667(6666.67) = 31666.67
  const aaii = computeAaii(facts, r);
  assert.equal(aaii.toFixed(2), '31666.67');
});

test('AAII: capital loss year clamps to zero', () => {
  const facts: CorpTaxYearFacts = {
    ...baseFacts(),
    capitalGainEvents: [
      // Net loss: proceeds < acb
      { source: 'stock', securityId: 1, proceeds: D('5000'), acb: D('15000'), outlays: D('0'), date: '2024-06-01' },
    ],
  };
  // grossGains = -10000; includableGains = -6666.67; AAII clamped at 0
  const aaii = computeAaii(facts, r);
  assert.equal(aaii.toFixed(2), '0.00');
});

test('AAII: capital loss offsets interest income, not below zero', () => {
  const facts: CorpTaxYearFacts = {
    ...baseFacts(),
    investmentIncome: {
      ...baseFacts().investmentIncome,
      interest: [{ source: 'GIC', amount: D('3000'), cadAmount: D('3000') }],
    },
    capitalGainEvents: [
      // Net loss of $20k → includable = -$13333.34; 3k - 13333.34 = -10333.34 clamped to 0
      { source: 'stock', securityId: 1, proceeds: D('0'), acb: D('20000'), outlays: D('0'), date: '2024-06-01' },
    ],
  };
  const aaii = computeAaii(facts, r);
  assert.equal(aaii.toFixed(2), '0.00');
});
