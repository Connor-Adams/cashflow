/**
 * buildT1 line-routing tests (2026-06 math audit):
 *
 *  - CPP/OAS retirement benefits belong on L11400/L11300 — ordinary income
 *    with NO CPP contributions, EI premiums, or Canada employment amount
 *    (they are neither pensionable nor insurable earnings).
 *  - employmentIncomeAdditions (plan-routed salary) must reach L10100 even
 *    when T4 slips exist — the T4-preference dedup only applies to actuals.
 *  - A negative net pensionIncome (pension-split transfer-out exceeding
 *    pension actuals) must not manufacture a negative pension credit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal.js';
import { ratesFor } from './brackets.js';
import { buildT1 } from './t1.js';
import type { TaxYearFacts } from './types.js';

const baseFacts = (): TaxYearFacts => ({
  year: 2025,
  jurisdiction: 'CA-ON',
  employmentIncome: [],
  selfEmploymentIncome: [],
  selfEmploymentExpenses: [],
  interestIncome: [],
  eligibleDividends: [],
  nonEligibleDividends: [],
  capitalGainEvents: [],
  rrspContribs: [],
  fhsaContribs: [],
  donations: [],
  slips: [],
  rentalIncome: [],
  rentalExpenses: [],
  medicalExpenses: [],
  carryforwards: { netCapitalLoss: D('0'), rrspRoom: D('0'), nonCapLoss: D('0'), instalmentsPaid: D('0'), fhsaLifetimeContributions: D('0') },
  ageAtYearEnd: 40,
});

test('CPP/OAS benefits land on L11400/L11300 with no CPP, EI, or employment amount', () => {
  const r = ratesFor(2025);
  const facts = baseFacts();
  facts.ageAtYearEnd = 72;
  facts.cppBenefits = D('16000');
  facts.oasBenefits = D('8500');

  const ret = buildT1(facts, r);

  const l11400 = ret.lines.find(l => l.code === 'L11400');
  const l11300 = ret.lines.find(l => l.code === 'L11300');
  assert.ok(l11400, 'L11400 CPP benefits line expected');
  assert.ok(l11300, 'L11300 OAS line expected');
  assert.equal(l11400!.amount.toFixed(2), '16000.00');
  assert.equal(l11300!.amount.toFixed(2), '8500.00');

  assert.equal(ret.totals.totalIncome.toFixed(2), '24500.00', 'benefits count in total income');
  // Retirement benefits are neither pensionable nor insurable earnings.
  assert.equal(ret.totals.cppContrib.toFixed(2), '0.00', 'no phantom CPP contributions');
  assert.equal(ret.totals.eiPremium.toFixed(2), '0.00', 'no phantom EI premiums');

  const l42000 = ret.lines.find(l => l.code === 'L42000');
  assert.ok(l42000);
  const empAmt = l42000!.inputs.find(i => i.source === 'Employment amount × low rate');
  assert.ok(empAmt);
  assert.equal(empAmt!.amount.toFixed(2), '0.00', 'no Canada employment amount on benefits');
});

test('employmentIncomeAdditions are added on top of T4 box 14 (routed salary not discarded)', () => {
  const r = ratesFor(2025);
  const facts = baseFacts();
  facts.employmentIncome = [{ source: 'Txn salary', amount: D('80000'), cadAmount: D('80000') }];
  facts.slips = [{ slipId: 1, slipType: 'T4', issuer: 'Employer', boxes: { box14: D('80000') } }];
  facts.employmentIncomeAdditions = [
    { source: 'integration:routed-salary', amount: D('60000'), cadAmount: D('60000') },
  ];

  const ret = buildT1(facts, r);

  const l10100 = ret.lines.find(l => l.code === 'L10100');
  assert.ok(l10100);
  assert.equal(l10100!.amount.toFixed(2), '140000.00', 'T4 box 14 + routed addition');
  // The T4-vs-computed reconciliation warning compares actuals only; the
  // routed addition (present in neither) must not trip it.
  assert.ok(
    !ret.warnings.some(w => w.includes('T4 box 14')),
    `no spurious T4 reconciliation warning, got: ${JSON.stringify(ret.warnings)}`,
  );
});

test('employmentIncomeAdditions apply on the computed path too (no T4 slips)', () => {
  const r = ratesFor(2025);
  const facts = baseFacts();
  facts.employmentIncomeAdditions = [
    { source: 'integration:routed-salary', amount: D('60000'), cadAmount: D('60000') },
  ];

  const ret = buildT1(facts, r);

  const l10100 = ret.lines.find(l => l.code === 'L10100');
  assert.ok(l10100);
  assert.equal(l10100!.amount.toFixed(2), '60000.00');
  // Routed salary IS pensionable employment income — CPP must apply to it.
  assert.ok(ret.totals.cppContrib.greaterThan(0), 'routed salary attracts CPP');
});

test('negative net pensionIncome (split transfer-out) yields a $0 pension credit, not negative', () => {
  const r = ratesFor(2025);
  const facts = baseFacts();
  facts.employmentIncome = [{ source: 'Txn salary', amount: D('120000'), cadAmount: D('120000') }];
  // Pension-split transfer-out routed by the household plan: 0 actuals − 30k.
  facts.pensionIncome = D('-30000');

  const ret = buildT1(facts, r);

  assert.equal(ret.totals.totalIncome.toFixed(2), '90000.00', 'transfer-out reduces total income');
  const l42000 = ret.lines.find(l => l.code === 'L42000');
  assert.ok(l42000);
  const pensionCredit = l42000!.inputs.find(i => i.source === 'Pension income credit');
  assert.ok(pensionCredit);
  assert.equal(pensionCredit!.amount.toFixed(2), '0.00', 'credit floors at zero');
});
