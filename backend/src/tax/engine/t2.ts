import { Decimal, sumD, maxZero } from '../util/decimal';
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

  // SBD calc
  const sbd = sbdEligibleIncome(abi, aaii, r);
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

  // Taxable capital gains
  const grossGains = sumD(facts.capitalGainEvents.map(e => e.proceeds.minus(e.acb).minus(e.outlays)));
  const includableGains = maxZero(grossGains.times(r.capitalGainsInclusion));
  push('L445', 'Taxable capital gains', includableGains);

  // Taxable income
  const taxableIncome = sbd.eligible.plus(sbd.generalRate).plus(investmentTaxableIncome).plus(includableGains)
    .minus(facts.carryforwards.nonCapLoss).minus(facts.carryforwards.netCapitalLoss);
  push('L300T', 'Taxable income', maxZero(taxableIncome));

  // Federal tax
  const fedSbdTax = sbd.eligible.times(r.corpAbiSbdRateFederal);
  const fedGeneralTax = sbd.generalRate.times(r.corpGeneralRateFederal);
  const fedInvestmentTax = investmentTaxableIncome.plus(includableGains).times(r.corpInvestmentRateFederal);
  const federalTax = fedSbdTax.plus(fedGeneralTax).plus(fedInvestmentTax);
  push('L700F', 'Federal tax', federalTax);

  // ON tax
  const onSbdTax = sbd.eligible.times(r.corpAbiSbdRateOntario);
  const onGeneralTax = sbd.generalRate.times(r.corpGeneralRateOntario);
  const onInvestmentTax = investmentTaxableIncome.plus(includableGains).times(r.corpInvestmentRateOntario);
  const provincialTax = onSbdTax.plus(onGeneralTax).plus(onInvestmentTax);
  push('L700P', 'Ontario corporate tax', provincialTax);

  // Refundable tax on AII (added to NERDTOH)
  const refundableTaxOnAii = investmentTaxableIncome.times(r.corpRefundableTaxOnAII);
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

  const gripEnding = facts.carryforwards.grip.plus(integ.gripAddition)
    .minus(sumD(facts.dividendsPaid.filter(d => d.kind === 'eligible').map(d => d.amount)));
  const cdaEnding = facts.carryforwards.cda.plus(integ.cdaAddition);
  const erdtohEnding = facts.carryforwards.erdtoh.plus(integ.erdtohAddition); // refund subtracted below
  const nerdtohEnding = facts.carryforwards.nerdtoh.plus(integ.nerdtohAddition);

  return {
    fiscalYear: facts.fiscalYear,
    lines,
    totals: {
      activeBusinessIncome: abi,
      sbdEligibleIncome: sbd.eligible,
      generalRateIncome: sbd.generalRate,
      aii: aaii,
      taxableIncome: maxZero(taxableIncome),
      federalTax,
      provincialTax,
      refundableTaxOnAii,
      dividendRefund: integ.dividendRefund,
      netTaxPayable,
      gripEnding: maxZero(gripEnding),
      cdaEnding,
      erdtohEnding: maxZero(erdtohEnding.minus(integ.dividendRefund)),
      nerdtohEnding,
    },
    warnings,
  };
}
