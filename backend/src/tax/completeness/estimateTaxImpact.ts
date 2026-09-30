import { D, type Decimal } from '../util/decimal';
import { buildT1 } from '../engine/t1';
import type { RateTable, TaxYearFacts } from '../engine/types';

/**
 * A change to the facts representing what a gap is hiding. Must return a NEW facts
 * object — several estimates are computed against one resolved fact set, and a
 * mutating addition would make each figure depend on the order they were computed.
 */
export type FactsAddition = (facts: TaxYearFacts) => TaxYearFacts;

/**
 * What fixing this gap would cost in tax: re-run the return with the gap's amount
 * added and take the delta in total payable.
 *
 * Not a stored per-dollar rate, because the marginal rate depends on what is already
 * counted. Measured in Connor's 2026: the $42,000 classification backlog was worth
 * ~$4,227 against a near-zero base (~10.5% marginal), while the $15,000 unimported
 * draw is worth $3,042 landing on top of it (~20.3%). An earlier draft of the spec
 * priced the second at "~$4,900" by reusing the first's rate — wrong by ~60%, in the
 * direction that makes the whole panel untrustworthy.
 */
export function estimateTaxImpact(
  facts: TaxYearFacts,
  rates: RateTable,
  addition: FactsAddition,
): string {
  const before = buildT1(facts, rates).totals.totalPayable;
  const after = buildT1(addition(facts), rates).totals.totalPayable;
  return after.minus(before).toFixed(2);
}

/**
 * The corp→personal draw case: money that left the corp as a dividend and never
 * landed on the return. Non-eligible because CDG is a CCPC paying out of
 * small-business-rate income; that is what every classified draw in prod resolves to.
 */
export function addNonEligibleDividend(amount: string | Decimal): FactsAddition {
  const value = D(amount);
  if (value.lessThan(0)) {
    throw new Error(
      `addNonEligibleDividend: refusing a negative amount (${value.toFixed(2)}). A gap `
      + 'represents missing income; a negative would report a refund as the cost of '
      + 'fixing the data.',
    );
  }
  return (facts) => ({
    ...facts,
    nonEligibleDividends: [
      ...facts.nonEligibleDividends,
      { source: 'completeness estimate', amount: value, cadAmount: value },
    ],
  });
}
