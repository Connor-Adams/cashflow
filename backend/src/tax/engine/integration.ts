import { D, Decimal, maxZero, sumD } from '../util/decimal';
import type { CorpTaxYearFacts, RateTable } from './types';

export type IntegrationResult = {
  gripAddition: Decimal;
  cdaAddition: Decimal;
  erdtohAddition: Decimal;
  nerdtohAddition: Decimal;
  dividendRefund: Decimal;
};

/**
 * Roll forward GRIP / CDA / RDTOH balances and compute dividend refund.
 *
 * - GRIP addition: general-rate income retained (post-tax) ≈ general taxable income × (1 - general rate)
 *   Simplified: gripAddition = generalRateIncome × 0.72 (federal+ON net of 26.5%).
 * - CDA addition: non-taxable half of capital gains
 * - ERDTOH addition: 38.33% of eligible portion of investment income (interest + foreign + non-CCPC dividends)
 *   Simplified Phase 3: erdtohAddition = (interest + rentNet) × refundable rate
 * - NERDTOH addition: 30.67% of investment income from CCPC sources
 *   Simplified Phase 3: nerdtohAddition = nonEligibleDividends received × 0.3067
 * - Dividend refund: lesser of (dividends paid × 38.33%, RDTOH balance), eligible vs non split by GRIP
 */
export function computeIntegration(
  facts: CorpTaxYearFacts,
  generalRateIncome: Decimal,
  r: RateTable,
): IntegrationResult {
  const generalRetention = D('1').minus(r.corpGeneralRateFederal.plus(r.corpGeneralRateOntario));
  const gripAddition = generalRateIncome.times(generalRetention);

  const grossGains = sumD(facts.capitalGainEvents.map(e => e.proceeds.minus(e.acb).minus(e.outlays)));
  const cdaAddition = maxZero(grossGains).times(D('1').minus(r.capitalGainsInclusion));

  const interest = sumD(facts.investmentIncome.interest.map(i => i.cadAmount));
  const rent = sumD(facts.investmentIncome.rentNet.map(i => i.cadAmount));
  const elDivReceived = sumD(facts.investmentIncome.eligibleDividends.map(i => i.cadAmount));
  const nonElDivReceived = sumD(facts.investmentIncome.nonEligibleDividends.map(i => i.cadAmount));

  const erdtohAddition = interest.plus(rent).plus(elDivReceived).times(D('0.3833'));
  const nerdtohAddition = nonElDivReceived.times(D('0.3067'));

  const dividendsPaidEligible = sumD(facts.dividendsPaid.filter(d => d.kind === 'eligible').map(d => d.amount));
  const dividendsPaidNonEligible = sumD(facts.dividendsPaid.filter(d => d.kind === 'non_eligible').map(d => d.amount));

  const refundForEligible = Decimal.min(
    dividendsPaidEligible.times(r.corpDividendRefundRate),
    facts.carryforwards.erdtoh.plus(erdtohAddition),
  );
  const refundForNonEligible = Decimal.min(
    dividendsPaidNonEligible.times(r.corpDividendRefundRate),
    facts.carryforwards.nerdtoh.plus(nerdtohAddition),
  );

  return {
    gripAddition,
    cdaAddition,
    erdtohAddition,
    nerdtohAddition,
    dividendRefund: refundForEligible.plus(refundForNonEligible),
  };
}
