import { D, Decimal, sumD, maxZero } from '../util/decimal';
import type { RateTable, TaxLine, TaxReturn, TaxYearFacts } from './types';
import { applyBrackets } from './brackets';
import { computeCppEmployee, computeEiEmployee } from './cpp-ei';
import { grossUpEligible, grossUpNonEligible, dtcFederal, dtcOntario } from './dividends';
import { taxableCapitalGains } from './capital-gains';
import {
  basicPersonalAmountFederalApplied,
  basicPersonalAmountOntarioApplied,
  spousalCreditFederal,
  spousalCreditOntario,
  ageCreditFederal,
  ageCreditOntario,
  employmentAmountFederalApplied,
  cppEiCreditAmount,
} from './credits';
// donationCreditFederal, donationCreditOntario, medicalCreditFederal imported in Phase 2 when data sources exist.

export function buildT1(facts: TaxYearFacts, r: RateTable): TaxReturn {
  const warnings: string[] = [];
  const lines: TaxLine[] = [];
  const push = (
    code: string,
    label: string,
    amount: Decimal,
    inputs: { source: string; amount: Decimal }[] = [],
    formula?: string
  ) => {
    lines.push({ code, label, amount, inputs, formula });
  };

  // Employment income L10100 — prefer T4 box 14 totals over computed txns; warn if diff > $50.
  const t4s = facts.slips.filter((s) => s.slipType === 'T4');
  const t4Box14Total = sumD(t4s.map((s) => s.boxes['box14'] ?? D('0')));
  const computedEmployment = sumD(facts.employmentIncome.map((i) => i.cadAmount));
  if (t4s.length > 0 && t4Box14Total.minus(computedEmployment).abs().greaterThan(50)) {
    warnings.push(
      `T4 box 14 total $${t4Box14Total.toFixed(2)} differs from computed employment income $${computedEmployment.toFixed(2)} by more than $50.`
    );
  }
  const employmentLine = t4s.length > 0 ? t4Box14Total : computedEmployment;
  push('L10100', 'Employment income', employmentLine,
    t4s.length > 0
      ? t4s.map((s) => ({ source: `Slip T4 #${s.slipId} box 14`, amount: s.boxes['box14'] ?? D('0') }))
      : facts.employmentIncome.map((i) => ({ source: i.source, amount: i.cadAmount })),
    t4s.length > 0 ? 'sum(T4.box14)' : 'sum(employmentTransactions.cad)'
  );

  // Interest L12100
  const interest = sumD(facts.interestIncome.map((i) => i.cadAmount));
  push('L12100', 'Interest and other investment income', interest,
    facts.interestIncome.map((i) => ({ source: i.source, amount: i.cadAmount })));

  // Eligible dividends L12000 (grossed-up amount)
  const eligibleActual = sumD(facts.eligibleDividends.map((i) => i.cadAmount));
  const eligibleGrossed = grossUpEligible(eligibleActual, r);
  push('L12000', 'Taxable amount of eligible dividends', eligibleGrossed,
    facts.eligibleDividends.map((i) => ({ source: i.source, amount: i.cadAmount })),
    `${r.dividendGrossUpEligible.plus(1).toString()} × actual`);

  // Non-eligible dividends L12010
  const nonElActual = sumD(facts.nonEligibleDividends.map((i) => i.cadAmount));
  const nonElGrossed = grossUpNonEligible(nonElActual, r);
  push('L12010', 'Taxable amount of non-eligible dividends', nonElGrossed,
    facts.nonEligibleDividends.map((i) => ({ source: i.source, amount: i.cadAmount })));

  // Capital gains L12700
  const cg = taxableCapitalGains(facts.capitalGainEvents, r, facts.carryforwards.netCapitalLoss);
  push('L12700', 'Taxable capital gains', cg.taxable,
    facts.capitalGainEvents.map((e) => ({
      source: `${e.source} ${e.date}`,
      amount: e.proceeds.minus(e.acb).minus(e.outlays),
    })),
    `gross × ${r.capitalGainsInclusion.toString()} − applied losses`);

  // Self-employment L13500 = revenue − expenses
  const seRev = sumD(facts.selfEmploymentIncome.map((i) => i.cadAmount));
  const seExp = sumD(facts.selfEmploymentExpenses.map((i) => i.cadAmount));
  const seNet = maxZero(seRev.minus(seExp));
  push('L13500', 'Self-employment income (net)', seNet,
    [
      ...facts.selfEmploymentIncome.map((i) => ({ source: i.source, amount: i.cadAmount })),
      ...facts.selfEmploymentExpenses.map((i) => ({ source: i.source, amount: i.cadAmount.negated() })),
    ],
    'sum(SE revenue) − sum(SE expenses)');

  // Total income L15000
  const totalIncome = sumD([employmentLine, interest, eligibleGrossed, nonElGrossed, cg.taxable, seNet]);
  push('L15000', 'Total income', totalIncome);

  // RRSP deduction L20800
  const rrsp = Decimal.min(sumD(facts.rrspContribs.map((c) => c.amount)), facts.carryforwards.rrspRoom);
  push('L20800', 'RRSP deduction', rrsp,
    facts.rrspContribs.map((c) => ({ source: c.source, amount: c.amount })),
    `min(contribs, rrspRoom=${facts.carryforwards.rrspRoom.toFixed(2)})`);

  // Net income L23600
  const netIncome = maxZero(totalIncome.minus(rrsp));
  push('L23600', 'Net income', netIncome);

  // Taxable income L26000 (apply non-cap loss carryforward)
  const nonCapLossApplied = Decimal.min(netIncome, facts.carryforwards.nonCapLoss);
  const taxableIncome = maxZero(netIncome.minus(nonCapLossApplied));
  push('L26000', 'Taxable income', taxableIncome,
    nonCapLossApplied.greaterThan(0)
      ? [{ source: 'non-cap loss carryforward applied', amount: nonCapLossApplied }]
      : []);

  // Federal tax before credits
  const federalTaxBeforeCredits = applyBrackets(taxableIncome, r.federalBrackets);
  push('L40424', 'Federal tax before credits', federalTaxBeforeCredits);

  // Federal non-refundable credits
  const bpaFedAmt = basicPersonalAmountFederalApplied(taxableIncome, r);
  const spousalFedAmt = facts.spouse ? spousalCreditFederal(facts.spouse.netIncome, r) : D('0');
  const ageFedAmt = ageCreditFederal(facts.ageAtYearEnd, netIncome, r);
  const employmentFedAmt = employmentAmountFederalApplied(employmentLine, r);
  const cppEmployee = computeCppEmployee(employmentLine, r);
  const eiEmployee = computeEiEmployee(employmentLine, r);
  const cppEiCreditEligible = cppEiCreditAmount(cppEmployee, eiEmployee);
  const fedCreditAmountsTotal = sumD([bpaFedAmt, spousalFedAmt, ageFedAmt, employmentFedAmt, cppEiCreditEligible]);
  const fedNonRefundableLowRatePart = fedCreditAmountsTotal.times(r.donationLowRate);

  // Donations (already a tax-credit value, not an amount × rate)
  // For Phase 1 we don't have a donations data source — set to 0 unless user enters via slip later.
  const donationsFedCredit = D('0');

  // Federal DTC (reduces federal tax dollar-for-dollar in credit-value form)
  const fedDtcEligible = dtcFederal(eligibleGrossed, 'eligible', r);
  const fedDtcNonEligible = dtcFederal(nonElGrossed, 'non_eligible', r);

  const federalTax = maxZero(
    federalTaxBeforeCredits
      .minus(fedNonRefundableLowRatePart)
      .minus(donationsFedCredit)
      .minus(fedDtcEligible)
      .minus(fedDtcNonEligible)
  );
  push('L42000', 'Net federal tax', federalTax,
    [
      { source: 'BPA × low rate', amount: bpaFedAmt.times(r.donationLowRate) },
      { source: 'Spousal × low rate', amount: spousalFedAmt.times(r.donationLowRate) },
      { source: 'Age × low rate', amount: ageFedAmt.times(r.donationLowRate) },
      { source: 'Employment amount × low rate', amount: employmentFedAmt.times(r.donationLowRate) },
      { source: 'CPP+EI × low rate', amount: cppEiCreditEligible.times(r.donationLowRate) },
      { source: 'DTC eligible', amount: fedDtcEligible },
      { source: 'DTC non-eligible', amount: fedDtcNonEligible },
    ]);

  // Ontario tax before credits
  const onTaxBeforeCredits = applyBrackets(taxableIncome, r.provincialBrackets);
  const bpaOnAmt = basicPersonalAmountOntarioApplied(taxableIncome, r);
  const spousalOnAmt = facts.spouse ? spousalCreditOntario(facts.spouse.netIncome, r) : D('0');
  const ageOnAmt = ageCreditOntario(facts.ageAtYearEnd, netIncome, r);
  const onCreditTotal = sumD([bpaOnAmt, spousalOnAmt, ageOnAmt, cppEiCreditEligible]).times(r.provincialBrackets[0].rate);
  const onDtcEligible = dtcOntario(eligibleGrossed, 'eligible', r);
  const onDtcNonEligible = dtcOntario(nonElGrossed, 'non_eligible', r);
  const onTax = maxZero(onTaxBeforeCredits.minus(onCreditTotal).minus(onDtcEligible).minus(onDtcNonEligible));
  push('L42800', 'Net Ontario tax', onTax);

  // ON surtax + Ontario Health Premium (use rate table arrays)
  const onSurtax = computeOnSurtax(onTax, r);
  const ohp = computeOhp(taxableIncome, r);
  push('L42801', 'ON surtax', onSurtax);
  push('L42802', 'Ontario Health Premium', ohp);

  // Totals
  const totalPayable = sumD([federalTax, onTax, onSurtax, ohp, cppEmployee, eiEmployee]);
  push('L43500', 'Total payable', totalPayable);

  // Tax deducted at source: sum T4 box 22 across all T4 slips.
  const taxDeductedAtSource = sumD(t4s.map((s) => s.boxes['box22'] ?? D('0')));
  push('L43700', 'Total income tax deducted', taxDeductedAtSource,
    t4s.map((s) => ({ source: `Slip T4 #${s.slipId} box 22`, amount: s.boxes['box22'] ?? D('0') })),
    'sum(T4.box22)');

  const instalmentsPaid = facts.carryforwards.instalmentsPaid;
  const totalCredits = taxDeductedAtSource.plus(instalmentsPaid);
  push('L48200', 'Total credits (tax deducted + instalments)', totalCredits);

  const refundOrOwing = totalPayable.minus(totalCredits);
  push('L48500', refundOrOwing.greaterThan(0) ? 'Balance owing' : 'Refund', refundOrOwing);

  return {
    year: facts.year,
    lines,
    totals: {
      totalIncome,
      netIncome,
      taxableIncome,
      federalTax,
      provincialTax: onTax.plus(onSurtax).plus(ohp),
      cppContrib: cppEmployee,
      eiPremium: eiEmployee,
      totalPayable,
      refundOrOwing,
    },
    warnings,
  };
}

function computeOnSurtax(onTax: Decimal, r: RateTable): Decimal {
  if (!r.onSurtaxBands) return D('0');
  let surtax = D('0');
  for (const band of r.onSurtaxBands) {
    if (onTax.greaterThan(band.threshold)) {
      surtax = surtax.plus(onTax.minus(band.threshold).times(band.rate));
    }
  }
  return surtax;
}

function computeOhp(taxableIncome: Decimal, r: RateTable): Decimal {
  let lower = D('0');
  for (const tier of r.ontarioHealthPremium) {
    const upper = tier.upTo ?? taxableIncome;
    if (taxableIncome.lessThan(lower)) break;
    if (taxableIncome.lessThanOrEqualTo(upper)) {
      const inBand = taxableIncome.minus(lower);
      return tier.flat.plus(inBand.times(tier.marginalRate));
    }
    lower = upper;
  }
  const last = r.ontarioHealthPremium[r.ontarioHealthPremium.length - 1];
  return last.flat;
}
