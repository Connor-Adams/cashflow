/**
 * The T1 engine must read the CRA box that holds the quantity it claims to want.
 *
 * Three boxes were wrong, and each failure had the same shape: a credit figure
 * wired into an income line, or an actual amount wired into a taxable-amount line.
 * Both look plausible on screen. For an owner-managed corp paying itself in
 * dividends they are tens of thousands of dollars.
 *
 *   L12010 read T5 box 26 — the dividend tax credit for ELIGIBLE dividends — as
 *   the taxable amount of NON-eligible dividends. Roughly a 15% figure on an
 *   income line, and because the reconciliation gate was keyed on the same box, a
 *   pure non-eligible T5 (boxes 10/11/12, box 26 empty) suppressed the computed
 *   dividends entirely without triggering any warning. Now box 11.
 *
 *   L12000 read T3 box 49 — the ACTUAL amount of eligible dividends — on a line
 *   labelled "taxable amount", understating it by the whole 38% gross-up. Now
 *   box 50.
 *
 * Neither correction had a test. These are those tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal';
import { ratesFor } from './brackets';
import { buildT1 } from './t1';
import type { SlipFact, TaxYearFacts } from './types';

const RATES = ratesFor(2026);

function facts(over: Partial<TaxYearFacts> = {}): TaxYearFacts {
  return {
    year: 2026,
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
    rentalIncome: [],
    rentalExpenses: [],
    medicalExpenses: [],
    slips: [],
    carryforwards: {
      netCapitalLoss: D('0'), rrspRoom: D('0'), nonCapLoss: D('0'),
      instalmentsPaid: D('0'), fhsaLifetimeContributions: D('0'), fhsaRoom: D('0'),
    },
    ageAtYearEnd: 40,
    ...over,
  } as TaxYearFacts;
}

function slip(slipType: SlipFact['slipType'], boxes: Record<string, string>): SlipFact {
  return {
    slipId: 1,
    slipType,
    issuer: 'Test',
    boxes: Object.fromEntries(Object.entries(boxes).map(([k, v]) => [k, D(v)])),
  };
}

const line = (ret: ReturnType<typeof buildT1>, code: string) =>
  ret.lines.find((l) => l.code === code)?.amount.toFixed(2);

test('a pure non-eligible T5 puts the box 11 taxable amount on L12010', () => {
  // Boxes 10/11/12: actual 50,000, taxable 57,500 (15% gross-up), DTC 5,275.
  // Box 26 is absent, which is normal — it only appears on eligible dividends.
  //
  // No computed dividends here, deliberately. The first version of this test also
  // supplied 50,000 of computed non-eligible dividends, whose gross-up is exactly
  // 57,500 — so it passed against the OLD box-26 code too, by coincidence, and
  // proved nothing. With the slip as the only source, the old code yields 0.00.
  const ret = buildT1(facts({
    slips: [slip('T5', { box10: '50000', box11: '57500', box12: '5275' })],
  }), RATES);
  assert.equal(line(ret, 'L12010'), '57500.00');
});

test('a pure non-eligible T5 reconciles against computed dividends', () => {
  // The old gate keyed on box 26, so this slip was decorative: L12010 fell back
  // to the computed amount and no divergence could ever be reported.
  const ret = buildT1(facts({
    slips: [slip('T5', { box10: '50000', box11: '57500', box12: '5275' })],
    nonEligibleDividends: [{ source: 'CDG', amount: D('10000'), cadAmount: D('10000') }],
  }), RATES);
  assert.equal(line(ret, 'L12010'), '57500.00', 'the slip must win over the computed amount');
  assert.ok(
    ret.warnings.some((w) => /non-eligible/i.test(w)),
    `expected a divergence warning, got ${JSON.stringify(ret.warnings)}`,
  );
});

test('the T5 DTC box is never read as income', () => {
  // The exact old failure: box 26 present, box 11 absent. L12010 must fall back to
  // the computed grossed-up amount, not put 5,275 on an income line.
  const ret = buildT1(facts({
    slips: [slip('T5', { box24: '40000', box25: '55200', box26: '8280' })],
    nonEligibleDividends: [{ source: 'CDG', amount: D('50000'), cadAmount: D('50000') }],
  }), RATES);
  assert.equal(line(ret, 'L12010'), '57500.00', 'computed 50,000 x 1.15, not the 8,280 DTC');
});

test('a T3 puts the box 50 taxable amount on L12000, not box 49', () => {
  // Box 49 actual 10,000; box 50 taxable 13,800. Reading 49 on a line labelled
  // "taxable amount" understates income by the whole gross-up.
  const ret = buildT1(facts({
    slips: [slip('T3', { box49: '10000', box50: '13800' })],
    eligibleDividends: [{ source: 'Trust', amount: D('10000'), cadAmount: D('10000') }],
  }), RATES);
  assert.equal(line(ret, 'L12000'), '13800.00');
});

test('a T3 carrying only box 49 does not drive L12000', () => {
  // Nothing should read box 49 any more, so a slip with only the actual amount
  // must leave the computed gross-up in place rather than under-reporting.
  const ret = buildT1(facts({
    slips: [slip('T3', { box49: '10000' })],
    eligibleDividends: [{ source: 'Trust', amount: D('10000'), cadAmount: D('10000') }],
  }), RATES);
  assert.equal(line(ret, 'L12000'), '13800.00', 'computed 10,000 x 1.38');
});

test('T5 box 25 and T3 box 50 add on L12000', () => {
  const ret = buildT1(facts({
    slips: [
      slip('T5', { box24: '10000', box25: '13800' }),
      { ...slip('T3', { box50: '6900' }), slipId: 2 },
    ],
  }), RATES);
  assert.equal(line(ret, 'L12000'), '20700.00');
});

test('T5 box 11 and T3 box 32 add on L12010', () => {
  // Box 32 is the taxable amount of non-eligible dividends on a T3 — the T3Form
  // label was corrected to match.
  const ret = buildT1(facts({
    slips: [
      slip('T5', { box10: '10000', box11: '11500' }),
      { ...slip('T3', { box32: '2300' }), slipId: 2 },
    ],
  }), RATES);
  assert.equal(line(ret, 'L12010'), '13800.00');
});

test('the corrected T3 form and the engine agree end to end', () => {
  // T3Form.tsx offers box 32 / 49 / 50 with corrected labels. A T3 filled in
  // through that form must land its taxable amounts on the income lines and its
  // actual amount nowhere.
  const ret = buildT1(facts({
    slips: [slip('T3', {
      box21: '4000', box23: '1000', box26: '500',
      box32: '3450', box49: '5000', box50: '6900',
    })],
  }), RATES);
  assert.equal(line(ret, 'L12000'), '6900.00', 'box 50, not box 49');
  assert.equal(line(ret, 'L12010'), '3450.00', 'box 32');
  assert.equal(line(ret, 'L12100'), '500.00', 'box 26 is other income/interest on a T3');
});
