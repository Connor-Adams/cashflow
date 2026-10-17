/**
 * All three corporate capital-gains sites must read the HIGH inclusion rate.
 *
 * Context: `capitalGainsInclusionHigh` was 0.666667 for the June 2024 increase
 * that was never enacted. Correcting 2026 to 0.5 raised the question of whether
 * the field should exist at all — and deleting it would have been invisible in
 * 2026, because `?? r.capitalGainsInclusion` falls back to 0.5, the same number.
 * It is not the same number in 2024, where the high rate is still 0.666667.
 *
 * So these tests inject a table whose two rates DIFFER, which is the only way to
 * tell a site that reads the high rate from one that reads the base rate. A test
 * written against 2026 alone would pass with the field deleted and prove nothing.
 *
 * Personal gains are a separate matter: `t1.ts` applies the high rate only above
 * `capitalGainsInclusionThreshold`, and corporations have no threshold.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal';
import { computeAaii } from './aaii';
import { computeIntegration } from './integration';
import { buildT2 } from './t2';
import { ratesFor } from './brackets';
import type { CorpTaxYearFacts, RateTable } from './types';

/** Base 0.5, high 0.8 — deliberately not a real rate, so a fallback is visible. */
const SPLIT_RATES: RateTable = {
  ...ratesFor(2026),
  capitalGainsInclusion: D('0.5'),
  capitalGainsInclusionHigh: D('0.8'),
};

function facts(): CorpTaxYearFacts {
  return {
    fiscalYear: { startDate: '2026-01-01', endDate: '2026-12-31' },
    jurisdiction: 'CA-ON',
    activeBusinessIncome: [],
    investmentIncome: {
      interest: [], eligibleDividends: [], nonEligibleDividends: [], rentNet: [],
    },
    // A clean 100,000 gain: proceeds 150,000, ACB 50,000, no outlays.
    capitalGainEvents: [{
      description: 'Sale', proceeds: D('150000'), acb: D('50000'), outlays: D('0'),
    }] as CorpTaxYearFacts['capitalGainEvents'],
    dividendsPaid: [],
    salaryPaid: D('0'),
    carryforwards: {
      grip: D('0'), cda: D('0'), erdtoh: D('0'), nerdtoh: D('0'),
      nonCapLoss: D('0'), netCapitalLoss: D('0'),
    },
  };
}

test('aaii.ts includes gains at the high rate', () => {
  // 100,000 x 0.8. At the base rate it would be 50,000.
  assert.equal(computeAaii(facts(), SPLIT_RATES).toFixed(2), '80000.00');
});

test('t2.ts L445 uses the high rate', () => {
  const ret = buildT2(facts(), SPLIT_RATES);
  assert.equal(ret.lines.find((l) => l.code === 'L445')?.amount.toFixed(2), '80000.00');
});

test('integration.ts credits the CDA with the NON-includable half at the high rate', () => {
  // CDA addition is gains x (1 - inclusion). With high = 0.8 that is 20,000; with
  // the base rate it would be 50,000 — so this site reading the wrong rate
  // overstates tax-free extractable surplus, the most expensive direction.
  const res = computeIntegration(facts(), D('0'), SPLIT_RATES);
  assert.equal(res.cdaAddition.toFixed(2), '20000.00');
});

test('2026 corporate gains compute at 0.5 with no threshold', () => {
  // The actual current behaviour, with the real table: a corp includes half of
  // every dollar of gain, and unlike an individual has no 250,000 step-up.
  //
  // This one documents rather than discriminates — it passes even if all three
  // sites read the base rate, because in 2026 the two rates are both 0.5. That is
  // precisely why the cases above inject a split table, and why this case alone
  // would have been false comfort.
  const big = facts();
  big.capitalGainEvents = [{
    description: 'Sale', proceeds: D('1050000'), acb: D('50000'), outlays: D('0'),
  }] as CorpTaxYearFacts['capitalGainEvents'];
  const ret = buildT2(big, ratesFor(2026));
  assert.equal(ret.lines.find((l) => l.code === 'L445')?.amount.toFixed(2), '500000.00');
  assert.equal(computeAaii(big, ratesFor(2026)).toFixed(2), '500000.00');
  assert.equal(computeIntegration(big, D('0'), ratesFor(2026)).cdaAddition.toFixed(2), '500000.00');
});

test('2024 corporate gains still compute at 0.666667', () => {
  // The field is not vestigial: removing it would silently change 2024.
  const ret = buildT2(facts(), ratesFor(2024));
  assert.equal(ret.lines.find((l) => l.code === 'L445')?.amount.toFixed(2), '66666.70');
});
