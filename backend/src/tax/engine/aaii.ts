import { Decimal, sumD, maxZero } from '../util/decimal';
import type { CorpTaxYearFacts, RateTable } from './types';

/**
 * Adjusted Aggregate Investment Income — used to grind the SBD limit.
 * Per ITA s.125(5.1): interest + non-eligible portion of dividends + 50% of capital gains
 * less 50% of allowable capital losses + rental income, minus deductions.
 * Phase 3: simplified to interest + dividends received + 50% of net cap gains + rent.
 */
export function computeAaii(facts: CorpTaxYearFacts, r: RateTable): Decimal {
  const interest = sumD(facts.investmentIncome.interest.map(i => i.cadAmount));
  const elDiv = sumD(facts.investmentIncome.eligibleDividends.map(i => i.cadAmount));
  const nonElDiv = sumD(facts.investmentIncome.nonEligibleDividends.map(i => i.cadAmount));
  const rentNet = sumD(facts.investmentIncome.rentNet.map(i => i.cadAmount));
  const grossGains = sumD(facts.capitalGainEvents.map(e => e.proceeds.minus(e.acb).minus(e.outlays)));
  const corpInclusionRate = r.capitalGainsInclusionHigh ?? r.capitalGainsInclusion;
  const includableGains = grossGains.times(corpInclusionRate);
  return maxZero(interest.plus(elDiv).plus(nonElDiv).plus(rentNet).plus(includableGains));
}
