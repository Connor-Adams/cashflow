import { D, Decimal, sumD, maxZero } from '../util/decimal';
import type { BusinessIncomeItem, CorpTaxYearFacts, CorpTaxReturn, RateTable, TaxLine } from './types';
import { computeAaii } from './aaii';
import { sbdEligibleIncome, ontarioSbdRate } from './sbd';
import { computeIntegration, isConnectedSource } from './integration';
import { capitalGainOf } from './capital-gains';

/**
 * A row on the expense side of active business income. Builders tag the side;
 * an untagged row falls back to its sign (a refund then reads as revenue, which
 * only matters under s.18(1)(p)).
 */
function isExpenseRow(i: BusinessIncomeItem): boolean {
  return i.side ? i.side === 'expense' : i.cadAmount.isNegative();
}

export function buildT2(facts: CorpTaxYearFacts, r: RateTable): CorpTaxReturn {
  // Fact-assembly caveats ride along with the engine's own warnings so the
  // return surfaces both to the caller as one list.
  const warnings: string[] = [...(facts.factWarnings ?? [])];
  const lines: TaxLine[] = [];
  const push = (code: string, label: string, amount: Decimal, inputs: { source: string; amount: Decimal }[] = [], formula?: string) => {
    lines.push({ code, label, amount, inputs, formula });
  };

  // ABI net
  const abi = sumD(facts.activeBusinessIncome.map(i => i.cadAmount));
  push('L300', 'Active business income', abi,
    facts.activeBusinessIncome.map(i => ({ source: i.source, amount: i.cadAmount })));

  // Personal services business (s.125(7)): the whole year's active business
  // income is PSB income, and s.18(1)(p) denies every expense except the
  // incorporated employee's remuneration. So PSB income = revenue − salary,
  // with the year's net expenses added back.
  const psb = facts.personalServicesBusiness === true;
  let psbIncome = D('0');
  if (psb) {
    const expenseRows = facts.activeBusinessIncome.filter(isExpenseRow);
    const disallowed = maxZero(sumD(expenseRows.map(i => i.cadAmount)).negated());
    push('L18P', 'Expenses denied under ITA 18(1)(p) (personal services business)', disallowed,
      expenseRows.map(i => ({ source: i.source, amount: i.cadAmount })));
    push('L18PS', 'Salary to the incorporated employee, deductible under ITA 18(1)(p)(i)', facts.salaryPaid);
    psbIncome = abi.plus(disallowed).minus(facts.salaryPaid);
    push('L432', 'Personal services business income', psbIncome);
    warnings.push(
      'Personal services business: all active business income this year is taxed as PSB income '
      + `(federal ${r.corpPsbRateFederal.times(100).toFixed(1)}% incl. the s.123.5 5% additional tax, `
      + `Ontario ${r.corpPsbRateOntario.times(100).toFixed(1)}%), with no small business deduction. `
      + 'Every expense other than the salary paid to the incorporated employee is denied (s.18(1)(p)). '
      + 'Benefits or allowances to that employee, selling or contract-negotiation costs, and legal '
      + 'costs of collecting fees (s.18(1)(p)(ii)-(iv)) are also deductible but are not separated '
      + 'from other expenses here — they are denied with the rest.',
    );
  }

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
  // A PSB earns no SBD: its income is not from an "active business" (s.125(7)).
  const sbd = sbdEligibleIncome(psb ? D('0') : abi, aaiiForSbd, r);
  push('L425', 'SBD limit (after AAII grind)', sbd.limit);
  push('L427', 'Income eligible for SBD', sbd.eligible);
  push('L430', 'General-rate active business income', sbd.generalRate);

  // Investment income — taxable
  const interest = sumD(facts.investmentIncome.interest.map(i => i.cadAmount));
  const rent = sumD(facts.investmentIncome.rentNet.map(i => i.cadAmount));
  // s.112(1): taxable dividends from connected corporations (intercorp
  // source-tagged) are deducted in computing taxable income — they bear no
  // Part I tax (Part IV / RDTOH is their regime, handled in computeIntegration).
  // Portfolio dividends are KEPT in Part I investment income as a documented
  // simplification: the engine taxes them at investment rates in lieu of
  // levying actual Part IV tax, while the matching 38.33% accrues to RDTOH.
  const connectedDivsReceived = sumD(
    facts.investmentIncome.eligibleDividends.filter(isConnectedSource).map(i => i.cadAmount),
  ).plus(sumD(
    facts.investmentIncome.nonEligibleDividends.filter(isConnectedSource).map(i => i.cadAmount),
  ));
  const nonElDivReceived = sumD(
    facts.investmentIncome.nonEligibleDividends.filter(i => !isConnectedSource(i)).map(i => i.cadAmount),
  );
  const elDivReceived = sumD(
    facts.investmentIncome.eligibleDividends.filter(i => !isConnectedSource(i)).map(i => i.cadAmount),
  );
  const investmentTaxableIncome = interest.plus(rent).plus(nonElDivReceived).plus(elDivReceived);
  push('L440', 'Investment taxable income', investmentTaxableIncome);
  if (connectedDivsReceived.greaterThan(0)) {
    push('L320', 'Taxable dividends deductible under s.112 (connected corps)', connectedDivsReceived);
  }

  // Taxable capital gains — corps use the HIGH inclusion rate on ALL gains, with
  // no 250,000 threshold. That rate is not always 66.67%: the June 2024 increase
  // was never enacted, so 2025 and 2026 carry 0.5 and only 2024 still holds
  // 0.666667. Read the field, never the era.
  const grossGains = sumD(facts.capitalGainEvents.map(capitalGainOf));
  const corpInclusionRate = r.capitalGainsInclusionHigh ?? r.capitalGainsInclusion;
  const includableGains = maxZero(grossGains.times(corpInclusionRate));
  push('L445', 'Taxable capital gains', includableGains);

  // Taxable income — net capital losses (s.111(1)(b)) only deduct against
  // taxable capital gains; non-capital losses (s.111(1)(a)) against any income.
  const netCapitalLossApplied = Decimal.min(facts.carryforwards.netCapitalLoss, includableGains);
  const taxableIncome = maxZero(
    sbd.eligible.plus(sbd.generalRate).plus(psbIncome).plus(investmentTaxableIncome).plus(includableGains)
      .minus(facts.carryforwards.nonCapLoss).minus(netCapitalLossApplied),
  );
  push('L300T', 'Taxable income', taxableIncome);

  // Allocate taxable income to the rate pools so loss carryforwards flow into
  // the tax calc (losses displace general-rate income first, then investment
  // income, then SBD income — mirroring the statutory residuals):
  // - SBD applies to the least of ABI, taxable income, business limit (s.125(1))
  // - investment-rate income is capped at taxable income minus the SBD amount (s.123.3)
  // - general-rate income is the residual — or, for a PSB, PSB income is
  //   (sbd.eligible and sbd.generalRate are both zero then, so the residual is
  //   exactly the PSB income left after losses)
  const sbdTaxBase = Decimal.min(sbd.eligible, taxableIncome);
  const aiiTaxBase = Decimal.min(
    investmentTaxableIncome.plus(includableGains).minus(netCapitalLossApplied),
    taxableIncome.minus(sbdTaxBase),
  );
  const residualTaxBase = taxableIncome.minus(sbdTaxBase).minus(aiiTaxBase);
  const psbTaxBase = psb ? residualTaxBase : D('0');
  const generalTaxBase = psb ? D('0') : residualTaxBase;

  // Federal tax
  const fedSbdTax = sbdTaxBase.times(r.corpAbiSbdRateFederal);
  const fedGeneralTax = generalTaxBase.times(r.corpGeneralRateFederal);
  const fedInvestmentTax = aiiTaxBase.times(r.corpInvestmentRateFederal);
  const fedPsbTax = psbTaxBase.times(r.corpPsbRateFederal);
  const federalTax = fedSbdTax.plus(fedGeneralTax).plus(fedInvestmentTax).plus(fedPsbTax);
  push('L700F', 'Federal tax', federalTax);

  // ON tax
  // Day-weighted when a rate change falls inside the year (s.31(4)).
  const onSbdTax = sbdTaxBase.times(ontarioSbdRate(facts.fiscalYear, r));
  const onGeneralTax = generalTaxBase.times(r.corpGeneralRateOntario);
  const onInvestmentTax = aiiTaxBase.times(r.corpInvestmentRateOntario);
  const onPsbTax = psbTaxBase.times(r.corpPsbRateOntario);
  const provincialTax = onSbdTax.plus(onGeneralTax).plus(onInvestmentTax).plus(onPsbTax);
  push('L700P', 'Ontario corporate tax', provincialTax);

  // Refundable tax on AII (added to NERDTOH) — base includes taxable capital
  // gains and is capped by the loss deductions above (via aiiTaxBase)
  const refundableTaxOnAii = aiiTaxBase.times(r.corpRefundableTaxOnAII);
  push('L450', 'Refundable Part I tax on investment income', refundableTaxOnAii);

  // Integration: GRIP, CDA, RDTOH additions, dividend refund. GRIP is computed
  // on the POST-loss general-rate residual (s.89(1) "adjusted taxable income"
  // starts from Division C taxable income), not the pre-loss sbd.generalRate.
  // PSB income belongs in it too: GRIP's adjusted taxable income removes only
  // the SBD-eligible amount and aggregate investment income, and PSB income is
  // neither — it is taxed at the full rate, so it can fund eligible dividends.
  const integ = computeIntegration(facts, residualTaxBase, r);
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
  // Pools roll forward by what was actually DRAWN from each (s.129(1)):
  // ERDTOH funds the eligible refund plus any non-eligible overflow; NERDTOH
  // funds only the non-eligible base refund.
  const erdtohEnding = maxZero(
    facts.carryforwards.erdtoh.plus(integ.erdtohAddition).minus(integ.erdtohConsumed),
  );
  const nerdtohEnding = maxZero(
    facts.carryforwards.nerdtoh.plus(integ.nerdtohAddition).minus(integ.nerdtohConsumed),
  );

  return {
    fiscalYear: facts.fiscalYear,
    lines,
    totals: {
      activeBusinessIncome: abi,
      sbdEligibleIncome: sbd.eligible,
      generalRateIncome: sbd.generalRate,
      personalServicesBusinessIncome: psbIncome,
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
