import { D, Decimal, maxZero, sumD } from '../util/decimal';
import type { CorpTaxYearFacts, IncomeItem, RateTable } from './types';

export type IntegrationResult = {
  gripAddition: Decimal;
  cdaAddition: Decimal;
  erdtohAddition: Decimal;
  nerdtohAddition: Decimal;
  /** Portion of the refund triggered by ELIGIBLE dividends paid (ERDTOH only, s.129(1)(a)(i)). */
  refundForEligible: Decimal;
  /**
   * Portion of the refund triggered by NON-ELIGIBLE dividends paid: NERDTOH
   * base plus, when NERDTOH is exhausted, the s.129(1)(a)(ii)(B) overflow from
   * whatever ERDTOH remains after the eligible refund.
   */
  refundForNonEligible: Decimal;
  /** Total = refundForEligible + refundForNonEligible. */
  dividendRefund: Decimal;
  /** ERDTOH drawn this year = eligible refund + non-eligible overflow. Reduces the ERDTOH pool. */
  erdtohConsumed: Decimal;
  /** NERDTOH drawn this year = non-eligible base refund. Reduces the NERDTOH pool. */
  nerdtohConsumed: Decimal;
};

/**
 * Source-tag prefix stamped by `intercorpRouter` on dividend `IncomeItem`s that
 * represent intercorp transfers. P11b T5 uses this to distinguish *connected*
 * (intercorp, ≥10% ownership) from *portfolio* dividends for Part IV / RDTOH,
 * and buildT2 uses it for the s.112 intercorporate dividend deduction.
 */
const INTERCORP_SOURCE_PREFIX = 'intercorpRouter:from-corp-';

export function isConnectedSource(item: IncomeItem): boolean {
  return item.source.startsWith(INTERCORP_SOURCE_PREFIX);
}

function portfolioSum(items: IncomeItem[]): Decimal {
  return sumD(items.filter(i => !isConnectedSource(i)).map(i => i.cadAmount));
}

/**
 * Part IV tax rate, s.186(1)(a): 38⅓% of assessable dividends from
 * non-connected payers — the SAME rate for eligible and non-eligible
 * dividends (the dividend's character only decides which RDTOH pool the tax
 * credits). Also the s.129(1) dividend-refund rate. Statutorily 115/300
 * (= 0.38333…); the engine keeps the 4-decimal convention used by
 * `corpDividendRefundRate` throughout the rate tables.
 */
const PART_IV_RATE = D('0.3833');

/**
 * GRIP "general rate factor", s.89(1): a STATUTORY constant — 0.72 for all
 * days after 2011 (day-prorated 0.68/0.69/0.70 only for 2009-2011 straddles,
 * irrelevant here). NOT derived from actual federal+provincial rates.
 */
const GRIP_GENERAL_RATE_FACTOR = D('0.72');

/**
 * Roll forward GRIP / CDA / RDTOH balances and compute dividend refund.
 *
 * - GRIP addition (s.89(1) element D): 0.72 × adjusted taxable income. The
 *   caller passes `postLossGeneralRateIncome` = taxable income − SBD income −
 *   investment-rate income, i.e. the POST-carryforward general-rate residual
 *   (buildT2's `generalTaxBase`) — loss carryforwards shrink the GRIP addition.
 * - CDA addition: non-taxable portion of capital gains
 * - ERDTOH addition: Part IV tax (38.33%) on portfolio ELIGIBLE dividends
 *   received (s.129(4) "ERDTOH" para (a)(i))
 * - NERDTOH addition: refundable Part I tax — 30.67% of aggregate investment
 *   income (interest + rent + taxable capital gains net of capital-loss
 *   carryforwards applied), plus Part IV tax (38.33%) on portfolio
 *   NON-ELIGIBLE dividends received (s.129(4) "NERDTOH" para (b) residual).
 *   (Simplification: the 30.67% AII amount skips the statutory least-of-three
 *   test in the NERDTOH definition — taxable-income cap and Part I tax cap.)
 * - Dividend refund (s.129(1)(a)): eligible dividends paid refund from ERDTOH
 *   ONLY (never NERDTOH); non-eligible dividends paid refund from NERDTOH
 *   first, and when 38.33% of non-eligible dividends exceeds NERDTOH the
 *   excess draws on whatever ERDTOH remains after the eligible refund
 *   (s.129(1)(a)(ii)(B)). `erdtohConsumed`/`nerdtohConsumed` report the
 *   per-pool draws so the caller can roll the pools forward.
 *
 * P11b T5 — Connected vs portfolio Part IV distinction (v1 SIMPLIFICATION):
 *   When an IncomeItem on `investmentIncome.{eligibleDividends, nonEligibleDividends}`
 *   carries a source tag starting with `intercorpRouter:from-corp-` (stamped by
 *   `intercorpRouter`), we treat it as a *connected* dividend (intercorp transfer,
 *   ownership ≥ 10%) and EXCLUDE it from the RDTOH addition base. Portfolio
 *   dividends (no intercorp source tag) continue to attract the 38.33%
 *   Part IV addition (eligible → ERDTOH, non-eligible → NERDTOH).
 *
 *   WARNING — v1 SIMPLIFICATION IS INCORRECT in the general case:
 *   The real Income Tax Act s.186(1)(b) rule for connected-corp Part IV is:
 *     Part IV tax = payer's actual dividend refund × (dividends received ÷
 *     total taxable dividends paid by the payer)
 *   That requires a two-pass compute (compute payer first to see its refund,
 *   then feed into receiver). v1 collapses this to zero by assuming the payer
 *   triggered a matching refund — which is FALSE when the payer had no RDTOH
 *   to refund. Deferred to P11c (multi-pass orchestrator).
 */
export function computeIntegration(
  facts: CorpTaxYearFacts,
  postLossGeneralRateIncome: Decimal,
  r: RateTable,
): IntegrationResult {
  const gripAddition = maxZero(postLossGeneralRateIncome).times(GRIP_GENERAL_RATE_FACTOR);

  const grossGains = sumD(facts.capitalGainEvents.map(e => e.proceeds.minus(e.acb).minus(e.outlays)));
  const corpInclusionRate = r.capitalGainsInclusionHigh ?? r.capitalGainsInclusion;
  const cdaAddition = maxZero(grossGains).times(D('1').minus(corpInclusionRate));

  const interest = sumD(facts.investmentIncome.interest.map(i => i.cadAmount));
  const rent = sumD(facts.investmentIncome.rentNet.map(i => i.cadAmount));
  // P11b T5: Only PORTFOLIO dividends (no `intercorpRouter:from-corp-` source
  // tag) contribute to ERDTOH/NERDTOH. Connected intercorp dividends are
  // excluded (v1 simplification — see header comment for caveats).
  const portfolioElDivReceived = portfolioSum(facts.investmentIncome.eligibleDividends);
  const portfolioNonElDivReceived = portfolioSum(facts.investmentIncome.nonEligibleDividends);

  // ERDTOH accrues Part IV tax on portfolio eligible dividends (38.33%).
  const erdtohAddition = portfolioElDivReceived.times(PART_IV_RATE);
  // NERDTOH accrues the refundable Part I tax on aggregate investment income
  // (30.67% of interest + rent + taxable capital gains, the latter net of
  // capital-loss carryforwards which are only deductible against gains),
  // plus Part IV tax on portfolio non-eligible dividends — Part IV is 38.33%
  // regardless of the dividend's eligibility (s.186(1)(a)).
  const includableGains = maxZero(grossGains.times(corpInclusionRate));
  const gainsNetOfLosses = includableGains.minus(
    Decimal.min(facts.carryforwards.netCapitalLoss, includableGains),
  );
  const nerdtohAddition = interest.plus(rent).plus(gainsNetOfLosses).times(D('0.3067'))
    .plus(portfolioNonElDivReceived.times(PART_IV_RATE));

  const dividendsPaidEligible = sumD(facts.dividendsPaid.filter(d => d.kind === 'eligible').map(d => d.amount));
  const dividendsPaidNonEligible = sumD(facts.dividendsPaid.filter(d => d.kind === 'non_eligible').map(d => d.amount));

  const erdtohAvailable = facts.carryforwards.erdtoh.plus(erdtohAddition);
  const nerdtohAvailable = facts.carryforwards.nerdtoh.plus(nerdtohAddition);

  // s.129(1)(a)(i): eligible refund draws on ERDTOH only — never NERDTOH.
  const refundForEligible = Decimal.min(
    dividendsPaidEligible.times(r.corpDividendRefundRate),
    erdtohAvailable,
  );
  // s.129(1)(a)(ii)(A): non-eligible base refund draws on NERDTOH first…
  const nonEligibleGross = dividendsPaidNonEligible.times(r.corpDividendRefundRate);
  const nonEligibleBase = Decimal.min(nonEligibleGross, nerdtohAvailable);
  // …(B): the excess overflows into ERDTOH, but only what the eligible refund
  // left behind (eligible refunds are charged against ERDTOH first).
  const nonEligibleOverflow = Decimal.min(
    maxZero(nonEligibleGross.minus(nerdtohAvailable)),
    maxZero(erdtohAvailable.minus(refundForEligible)),
  );
  const refundForNonEligible = nonEligibleBase.plus(nonEligibleOverflow);

  return {
    gripAddition,
    cdaAddition,
    erdtohAddition,
    nerdtohAddition,
    refundForEligible,
    refundForNonEligible,
    dividendRefund: refundForEligible.plus(refundForNonEligible),
    erdtohConsumed: refundForEligible.plus(nonEligibleOverflow),
    nerdtohConsumed: nonEligibleBase,
  };
}
