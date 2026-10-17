/**
 * A gap's tax impact must be computed by re-running the return, never from a
 * stored per-dollar rate.
 *
 * This is measured, not stylistic. In Connor's real 2026 the $42,000 classification
 * backlog was worth ~$4,227 of tax because it landed on a near-zero base (total
 * payable $300.00), a marginal ~10.5%. The $15,000 unimported draw is worth $3,042
 * because it lands on TOP of that, at ~20.3%. An earlier draft of the spec priced
 * the $15,000 at "~$4,900" by reusing the backlog's rate — wrong by ~60%, and
 * wrong in the direction that makes the panel untrustworthy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal';
import { ratesFor } from '../engine/brackets';
import { estimateTaxImpact, addNonEligibleDividend } from './estimateTaxImpact';
import type { TaxYearFacts } from '../engine/types';

const RATES = ratesFor(2026);

function facts(over: Partial<TaxYearFacts> = {}): TaxYearFacts {
  return {
    year: 2026, jurisdiction: 'CA-ON',
    employmentIncome: [], selfEmploymentIncome: [], selfEmploymentExpenses: [],
    interestIncome: [], eligibleDividends: [], nonEligibleDividends: [],
    capitalGainEvents: [], rrspContribs: [], fhsaContribs: [], donations: [],
    rentalIncome: [], rentalExpenses: [], medicalExpenses: [], slips: [],
    carryforwards: {
      netCapitalLoss: D('0'), rrspRoom: D('0'), nonCapLoss: D('0'),
      instalmentsPaid: D('0'), fhsaLifetimeContributions: D('0'), fhsaRoom: D('0'),
    },
    ageAtYearEnd: 40,
    ...over,
  } as TaxYearFacts;
}

const div = (amount: string) => ({
  source: 'CDG', amount: D(amount), cadAmount: D(amount),
});

test('the same amount costs more on a bigger base', () => {
  // The whole reason this is a re-run and not a rate. Identical $15,000 gap.
  const onEmpty = estimateTaxImpact(facts(), RATES, addNonEligibleDividend('15000'));
  const onBacklog = estimateTaxImpact(
    facts({ nonEligibleDividends: [div('42000')] }), RATES, addNonEligibleDividend('15000'),
  );
  assert.ok(
    D(onBacklog).greaterThan(D(onEmpty)),
    `expected the stacked estimate to exceed the bare one, got ${onBacklog} vs ${onEmpty}`,
  );
});

test('the estimate is the delta, not the new total', () => {
  const est = estimateTaxImpact(facts(), RATES, addNonEligibleDividend('15000'));
  // A $15,000 non-eligible dividend against nothing else cannot cost $15,000 of tax,
  // and it cannot be the whole recomputed payable either.
  assert.ok(D(est).greaterThanOrEqualTo(0), est);
  assert.ok(D(est).lessThan(D('15000')), est);
});

test('a zero addition costs zero', () => {
  assert.equal(estimateTaxImpact(facts(), RATES, addNonEligibleDividend('0')), '0.00');
});

test('the addition does not mutate the caller\'s facts', () => {
  // The report computes several estimates against one resolved fact set; a mutating
  // estimator would make each gap's figure depend on the order they were computed.
  const f = facts({ nonEligibleDividends: [div('42000')] });
  estimateTaxImpact(f, RATES, addNonEligibleDividend('15000'));
  assert.equal(f.nonEligibleDividends.length, 1);
  assert.equal(f.nonEligibleDividends[0].cadAmount.toFixed(2), '42000.00');
});

test('two estimates against one fact set are independent', () => {
  const f = facts({ nonEligibleDividends: [div('42000')] });
  const a = estimateTaxImpact(f, RATES, addNonEligibleDividend('15000'));
  const b = estimateTaxImpact(f, RATES, addNonEligibleDividend('15000'));
  assert.equal(a, b, 'the second estimate must not stack on the first');
});

test("Connor's real 2026 shape: $15,000 on top of $67,000 of draws", () => {
  // The regression figure the spec measured: $3,041.79, reproduced here to the cent
  // from an independent direction.
  //
  // The base is $67,000 — the total draws once the $42,000 backlog is classified —
  // not $42,000. Getting that wrong was worth $800: against a bare $42,000 the same
  // gap estimates $2,223.07, because the top of the $42,000 base sits in the 20.05%
  // Ontario band while the top of the $67,000 base has crossed into the next one.
  //
  // This fixture's absolute payables ($5,363.94 -> $8,405.73) sit about $836 above
  // the spec's ($4,527.17 -> $7,568.96) because the real fact set carries deductions
  // and credits this one does not. The DELTA is what matters and it matches, which is
  // the point: the estimate depends on the marginal band, and those items do not
  // move it.
  //
  // $3,041.80, one cent above the spec's $3,041.79. The spec's figure subtracted two
  // ROUNDED totals; the estimator subtracts unrounded Decimals and rounds once, so
  // the true delta is 3,041.795... The estimator's order is the correct one.
  const est = estimateTaxImpact(
    facts({ nonEligibleDividends: [div('67000')] }), RATES, addNonEligibleDividend('15000'),
  );
  assert.equal(est, '3041.80');
});

test('the same gap against the $42,000 base estimates materially less', () => {
  // The direct test that the impact is re-run rather than looked up. Two bases one
  // bracket apart, same $15,000: $2,223.07 against $3,041.80, a 37% difference.
  const onBacklog = estimateTaxImpact(
    facts({ nonEligibleDividends: [div('42000')] }), RATES, addNonEligibleDividend('15000'),
  );
  assert.equal(onBacklog, '2223.07');
});

test('a negative addition is refused', () => {
  // A gap represents missing income. A negative would silently report a refund as
  // the cost of fixing the data.
  assert.throws(() => estimateTaxImpact(facts(), RATES, addNonEligibleDividend('-100')), /negative/i);
});
