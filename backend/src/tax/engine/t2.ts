import { D, Decimal, sumD, maxZero } from '../util/decimal';
import type { CorpTaxYearFacts, CorpTaxReturn, RateTable, TaxLine } from './types';
import { computeAaii } from './aaii';
import { sbdEligibleIncome } from './sbd';
import { computeIntegration } from './integration';

export function buildT2(facts: CorpTaxYearFacts, r: RateTable): CorpTaxReturn {
  const warnings: string[] = [];
  const lines: TaxLine[] = [];
  const push = (code: string, label: string, amount: Decimal, inputs: { source: string; amount: Decimal }[] = [], formula?: string) => {
    lines.push({ code, label, amount, inputs, formula });
  };

  // ABI net
  const abi = sumD(facts.activeBusinessIncome.map(i => i.cadAmount));
  push('L300', 'Active business income', abi,
    facts.activeBusinessIncome.map(i => ({ source: i.source, amount: i.cadAmount })));

  // AAII (for SBD grind)
  const aaii = computeAaii(facts, r);
  push('L417', 'Adjusted aggregate investment income', aaii);

  // SBD calc — P11b: if associated-group AAII was injected, use it for the
  // grind so the $500k SBD limit / $50k AAII threshold is shared across the
  // group (s.125(5.1)). Otherwise fall back to per-corp AAII.
  const aaiiForSbd = facts.groupAaii ?? aaii;
  if (facts.groupAaii) {
    push('L417G', 'Group AAII (used for SBD grind)', aaiiForSbd);
  }
  const sbd = sbdEligibleIncome(abi, aaiiForSbd, r);
  push('L425', 'SBD limit (after AAII grind)', sbd.limit);
  push('L427', 'Income eligible for SBD', sbd.eligible);
  push('L430', 'General-rate active business income', sbd.generalRate);

  // Investment income — taxable
  const interest = sumD(facts.investmentIncome.interest.map(i => i.cadAmount));
  const rent = sumD(facts.investmentIncome.rentNet.map(i => i.cadAmount));
  const nonElDivReceived = sumD(facts.investmentIncome.nonEligibleDividends.map(i => i.cadAmount));
  // Eligible dividends received from non-connected corps are subject to Part IV but treated as taxable investment income at corp level
  const elDivReceived = sumD(facts.investmentIncome.eligibleDividends.map(i => i.cadAmount));
  const investmentTaxableIncome = interest.plus(rent).plus(nonElDivReceived).plus(elDivReceived);
  push('L440', 'Investment taxable income', investmentTaxableIncome);

  // Taxable capital gains — corps use the high rate (66.67%) on ALL gains
  const grossGains = sumD(facts.capitalGainEvents.map(e => e.proceeds.minus(e.acb).minus(e.outlays)));
  const corpInclusionRate = r.capitalGainsInclusionHigh ?? r.capitalGainsInclusion;
  const includableGains = maxZero(grossGains.times(corpInclusionRate));
  push('L445', 'Taxable capital gains', includableGains);

  // Taxable income — net capital losses (s.111(1)(b)) only deduct against
  // taxable capital gains; non-capital losses (s.111(1)(a)) against any income.
  const netCapitalLossApplied = Decimal.min(facts.carryforwards.netCapitalLoss, includableGains);
  const taxableIncome = maxZero(
    sbd.eligible.plus(sbd.generalRate).plus(investmentTaxableIncome).plus(includableGains)
      .minus(facts.carryforwards.nonCapLoss).minus(netCapitalLossApplied),
  );
  push('L300T', 'Taxable income', taxableIncome);

  // Allocate taxable income to the rate pools so loss carryforwards flow into
  // the tax calc (losses displace general-rate income first, then investment
  // income, then SBD income — mirroring the statutory residuals):
  // - SBD applies to the least of ABI, taxable income, business limit (s.125(1))
  // - investment-rate income is capped at taxable income minus the SBD amount (s.123.3)
  // - general-rate income is the residual
  const sbdTaxBase = Decimal.min(sbd.eligible, taxableIncome);
  const aiiTaxBase = Decimal.min(
    investmentTaxableIncome.plus(includableGains).minus(netCapitalLossApplied),
    taxableIncome.minus(sbdTaxBase),
  );
  const generalTaxBase = taxableIncome.minus(sbdTaxBase).minus(aiiTaxBase);

  // Federal tax
  const fedSbdTax = sbdTaxBase.times(r.corpAbiSbdRateFederal);
  const fedGeneralTax = generalTaxBase.times(r.corpGeneralRateFederal);
  const fedInvestmentTax = aiiTaxBase.times(r.corpInvestmentRateFederal);
  const federalTax = fedSbdTax.plus(fedGeneralTax).plus(fedInvestmentTax);
  push('L700F', 'Federal tax', federalTax);

  // ON tax
  const onSbdTax = sbdTaxBase.times(r.corpAbiSbdRateOntario);
  const onGeneralTax = generalTaxBase.times(r.corpGeneralRateOntario);
  const onInvestmentTax = aiiTaxBase.times(r.corpInvestmentRateOntario);
  const provincialTax = onSbdTax.plus(onGeneralTax).plus(onInvestmentTax);
  push('L700P', 'Ontario corporate tax', provincialTax);

  // Refundable tax on AII (added to NERDTOH) — base includes taxable capital
  // gains and is capped by the loss deductions above (via aiiTaxBase)
  const refundableTaxOnAii = aiiTaxBase.times(r.corpRefundableTaxOnAII);
  push('L450', 'Refundable Part I tax on investment income', refundableTaxOnAii);

  // Integration: GRIP, CDA, RDTOH additions, dividend refund
  const integ = computeIntegration(facts, sbd.generalRate, r);
  push('L500', 'GRIP addition', integ.gripAddition);
  push('L501', 'CDA addition', integ.cdaAddition);
  push('L502', 'ERDTOH addition', integ.erdtohAddition);
  push('L503', 'NERDTOH addition', integ.nerdtohAddition);
  push('L780', 'Dividend refund', integ.dividendRefund);

  const netTaxPayable = maxZero(federalTax.plus(provincialTax).minus(integ.dividendRefund));
  push('L770', 'Net tax payable', netTaxPayable);

  // P11b T6: GRIP designation from received intercorp eligible dividends
  // (Σ eligible × ownership%/100) flows in via `openingGripBoost`, injected by
  // computeHouseholdPlan from `intercorpRouter`'s gripBoost output.
  const openingGripBoost = facts.openingGripBoost ?? D('0');
  if (openingGripBoost.greaterThan(0)) {
    push('L500B', 'GRIP boost from intercorp eligible dividends received', openingGripBoost);
  }
  const gripEnding = facts.carryforwards.grip
    .plus(integ.gripAddition)
    .plus(openingGripBoost)
    .minus(sumD(facts.dividendsPaid.filter(d => d.kind === 'eligible').map(d => d.amount)));
  const cdaEnding = facts.carryforwards.cda.plus(integ.cdaAddition);
  // Each refund draws only on its own pool: eligible-dividend refunds reduce
  // ERDTOH, non-eligible refunds reduce NERDTOH.
  const erdtohEnding = maxZero(
    facts.carryforwards.erdtoh.plus(integ.erdtohAddition).minus(integ.refundForEligible),
  );
  const nerdtohEnding = maxZero(
    facts.carryforwards.nerdtoh.plus(integ.nerdtohAddition).minus(integ.refundForNonEligible),
  );

  return {
    fiscalYear: facts.fiscalYear,
    lines,
    totals: {
      activeBusinessIncome: abi,
      sbdEligibleIncome: sbd.eligible,
      generalRateIncome: sbd.generalRate,
      aii: aaii,
      taxableIncome,
      federalTax,
      provincialTax,
      refundableTaxOnAii,
      dividendRefund: integ.dividendRefund,
      netTaxPayable,
      gripEnding: maxZero(gripEnding),
      cdaEnding,
      erdtohEnding,
      nerdtohEnding,
    },
    warnings,
  };
}
