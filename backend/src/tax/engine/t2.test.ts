import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal';
import { buildT2 } from './t2';
import { ratesFor } from './brackets';
import type { BusinessIncomeItem, CorpTaxYearFacts } from './types';

// Personal services business (ITA s.125(7)): an incorporated employee's
// income, taxed at the full rate with no SBD, the s.123.5 5% additional tax and
// every expense but the employee's remuneration denied (s.18(1)(p)).

const r = ratesFor(2026);

const revenue = (amount: string, source = 'client'): BusinessIncomeItem =>
  ({ source, amount: D(amount), cadAmount: D(amount), side: 'revenue' });
const expense = (amount: string, source = 'vendor'): BusinessIncomeItem =>
  ({ source, amount: D(amount), cadAmount: D(amount), side: 'expense' });

function facts(over: Partial<CorpTaxYearFacts> = {}): CorpTaxYearFacts {
  return {
    fiscalYear: { startDate: '2026-01-01', endDate: '2026-12-31' },
    jurisdiction: 'CA-ON',
    // 150,000 of fees, 20,000 of ordinary business expenses.
    activeBusinessIncome: [revenue('150000'), expense('-20000')],
    investmentIncome: { interest: [], eligibleDividends: [], nonEligibleDividends: [], rentNet: [] },
    capitalGainEvents: [],
    dividendsPaid: [],
    salaryPaid: D('60000'),
    carryforwards: {
      grip: D('0'), cda: D('0'), erdtoh: D('0'), nerdtoh: D('0'),
      nonCapLoss: D('0'), netCapitalLoss: D('0'),
    },
    ...over,
  };
}

const lineAmount = (ret: ReturnType<typeof buildT2>, code: string) =>
  ret.lines.find((l) => l.code === code)?.amount.toFixed(2);

test('PSB rates: 33% federal (38 − 10 abatement + 5 s.123.5) and 11.5% Ontario, 2024-2027', () => {
  for (const year of [2024, 2025, 2026, 2027]) {
    const t = ratesFor(year);
    assert.equal(t.corpPsbRateFederal.toFixed(4), '0.3300', `${year} federal`);
    assert.equal(t.corpPsbRateOntario.toFixed(4), '0.1150', `${year} Ontario`);
  }
});

test('unflagged: active business income keeps the small business deduction', () => {
  const ret = buildT2(facts(), r);

  assert.equal(ret.totals.activeBusinessIncome.toFixed(2), '130000.00');
  assert.equal(ret.totals.sbdEligibleIncome.toFixed(2), '130000.00');
  assert.equal(ret.totals.personalServicesBusinessIncome.toFixed(2), '0.00');
  assert.equal(ret.totals.federalTax.toFixed(2), '11700.00');   // 130,000 × 9%
  assert.equal(ret.totals.provincialTax.toFixed(2), '4160.00'); // 130,000 × 3.2%
  assert.equal(lineAmount(ret, 'L432'), undefined, 'no PSB line');
  assert.ok(!ret.warnings.some((w) => /personal services business/i.test(w)));
});

test('flagged: no SBD, expenses denied, salary deducted, taxed at 33% + 11.5%', () => {
  const ret = buildT2(facts({ personalServicesBusiness: true }), r);

  // 150,000 revenue − 60,000 salary; the 20,000 of expenses is denied.
  assert.equal(lineAmount(ret, 'L18P'), '20000.00');
  assert.equal(lineAmount(ret, 'L18PS'), '60000.00');
  assert.equal(lineAmount(ret, 'L432'), '90000.00');
  assert.equal(ret.totals.personalServicesBusinessIncome.toFixed(2), '90000.00');
  assert.equal(ret.totals.sbdEligibleIncome.toFixed(2), '0.00');
  assert.equal(ret.totals.generalRateIncome.toFixed(2), '0.00');
  assert.equal(ret.totals.taxableIncome.toFixed(2), '90000.00');
  assert.equal(ret.totals.federalTax.toFixed(2), '29700.00');    // 90,000 × 33%
  assert.equal(ret.totals.provincialTax.toFixed(2), '10350.00'); // 90,000 × 11.5%
  assert.equal(ret.totals.netTaxPayable.toFixed(2), '40050.00'); // 44.5%
  assert.ok(ret.warnings.some((w) => /personal services business/i.test(w) && /18\(1\)\(p\)/.test(w)));
});

test('flagged: PSB income is full-rate income, so it feeds GRIP at 0.72', () => {
  const ret = buildT2(facts({ personalServicesBusiness: true }), r);
  assert.equal(lineAmount(ret, 'L500'), '64800.00'); // 90,000 × 0.72
  assert.equal(ret.totals.gripEnding.toFixed(2), '64800.00');

  const unflagged = buildT2(facts(), r);
  assert.equal(unflagged.totals.gripEnding.toFixed(2), '0.00', 'SBD income adds nothing to GRIP');
});

test('flagged: a refund on the expense side nets the denied amount, not revenue', () => {
  const ret = buildT2(facts({
    personalServicesBusiness: true,
    activeBusinessIncome: [revenue('150000'), expense('-20000'), expense('5000', 'vendor refund')],
  }), r);
  assert.equal(lineAmount(ret, 'L18P'), '15000.00');
  assert.equal(lineAmount(ret, 'L432'), '90000.00', '150,000 − 60,000 either way');
});

test('flagged: untagged rows fall back to their sign', () => {
  const ret = buildT2(facts({
    personalServicesBusiness: true,
    activeBusinessIncome: [
      { source: 'override', amount: D('150000'), cadAmount: D('150000') },
      { source: 'override cost', amount: D('-20000'), cadAmount: D('-20000') },
    ],
  }), r);
  assert.equal(lineAmount(ret, 'L18P'), '20000.00');
  assert.equal(lineAmount(ret, 'L432'), '90000.00');
});

test('flagged: loss carryforwards reduce PSB income; investment income keeps its own rate', () => {
  const ret = buildT2(facts({
    personalServicesBusiness: true,
    investmentIncome: {
      interest: [{ source: 'bank', amount: D('10000'), cadAmount: D('10000') }],
      eligibleDividends: [], nonEligibleDividends: [], rentNet: [],
    },
    carryforwards: {
      grip: D('0'), cda: D('0'), erdtoh: D('0'), nerdtoh: D('0'),
      nonCapLoss: D('30000'), netCapitalLoss: D('0'),
    },
  }), r);
  // Taxable income 90,000 + 10,000 − 30,000 = 70,000: 10,000 investment, 60,000 PSB.
  assert.equal(ret.totals.taxableIncome.toFixed(2), '70000.00');
  assert.equal(ret.totals.federalTax.toFixed(2), '23670.00');   // 60,000 × 33% + 10,000 × 38.7%
  assert.equal(ret.totals.provincialTax.toFixed(2), '8050.00'); // 70,000 × 11.5%
  assert.equal(lineAmount(ret, 'L500'), '43200.00');            // 60,000 × 0.72
});

test('flagged: salary above net revenue leaves no PSB tax', () => {
  const ret = buildT2(facts({ personalServicesBusiness: true, salaryPaid: D('200000') }), r);
  assert.equal(lineAmount(ret, 'L432'), '-50000.00'); // 150,000 − 200,000
  assert.equal(ret.totals.taxableIncome.toFixed(2), '0.00');
  assert.equal(ret.totals.netTaxPayable.toFixed(2), '0.00');
});
