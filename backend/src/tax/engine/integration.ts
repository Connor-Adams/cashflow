import { D, Decimal, maxZero, sumD } from '../util/decimal';
import type { CorpTaxYearFacts, IncomeItem, RateTable } from './types';

export type IntegrationResult = {
  gripAddition: Decimal;
  cdaAddition: Decimal;
  erdtohAddition: Decimal;
  nerdtohAddition: Decimal;
  dividendRefund: Decimal;
};

/**
 * Source-tag prefix stamped by `intercorpRouter` on dividend `IncomeItem`s that
 * represent intercorp transfers. P11b T5 uses this to distinguish *connected*
 * (intercorp, ≥10% ownership) from *portfolio* dividends for Part IV / RDTOH.
 */
const INTERCORP_SOURCE_PREFIX = 'intercorpRouter:from-corp-';

function isConnectedSource(item: IncomeItem): boolean {
  return item.source.startsWith(INTERCORP_SOURCE_PREFIX);
}

function portfolioSum(items: IncomeItem[]): Decimal {
  return sumD(items.filter(i => !isConnectedSource(i)).map(i => i.cadAmount));
}

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
 *
 * P11b T5 — Connected vs portfolio Part IV distinction (v1 SIMPLIFICATION):
 *   When an IncomeItem on `investmentIncome.{eligibleDividends, nonEligibleDividends}`
 *   carries a source tag starting with `intercorpRouter:from-corp-` (stamped by
 *   `intercorpRouter`), we treat it as a *connected* dividend (intercorp transfer,
 *   ownership ≥ 10%) and EXCLUDE it from the RDTOH addition base. Portfolio
 *   dividends (no intercorp source tag) continue to attract the existing
 *   38.33% / 30.67% Part IV addition.
 *
 *   WARNING — v1 SIMPLIFICATION IS INCORRECT in the general case:
 *   The real Income Tax Act s.186 rule for connected-corp Part IV is:
 *     Part IV tax = payer's actual dividend refund × (ownership % of payer)
 *   That requires a two-pass compute (compute payer first to see its refund,
 *   then feed into receiver). v1 collapses this to zero by assuming the payer
 *   triggered a matching refund — which is FALSE when the payer had no RDTOH
 *   to refund. Deferred to P11c (multi-pass orchestrator).
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
  // P11b T5: Only PORTFOLIO dividends (no `intercorpRouter:from-corp-` source
  // tag) contribute to ERDTOH/NERDTOH. Connected intercorp dividends are
  // excluded (v1 simplification — see header comment for caveats).
  const portfolioElDivReceived = portfolioSum(facts.investmentIncome.eligibleDividends);
  const portfolioNonElDivReceived = portfolioSum(facts.investmentIncome.nonEligibleDividends);

  const erdtohAddition = interest.plus(rent).plus(portfolioElDivReceived).times(D('0.3833'));
  const nerdtohAddition = portfolioNonElDivReceived.times(D('0.3067'));

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
