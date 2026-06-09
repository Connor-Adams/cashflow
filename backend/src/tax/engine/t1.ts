import { D, Decimal, sumD, maxZero } from '../util/decimal';
import type { RateTable, TaxLine, TaxReturn, TaxYearFacts } from './types';
import { applyBrackets } from './brackets';
import { computeAmt } from './amt';
import { computeCppEmployee, computeEiEmployee, computeCppSelfEmployed } from './cpp-ei';
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
  donationCreditFederal,
  donationCreditOntario,
  disabilityCreditFederal,
  caregiverCreditFederal,
  tuitionCreditFederal,
  pensionIncomeCreditFederal,
  pensionIncomeCreditOntario,
  medicalCreditFederal,
  medicalCreditOntario,
  oasClawback,
} from './credits';

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

  // T5 slip reconciliation: prefer slip amounts when present
  const t5s = facts.slips.filter(s => s.slipType === 'T5');
  const t5Box13Total = sumD(t5s.map(s => s.boxes['box13'] ?? D('0')));
  const t5Box25Total = sumD(t5s.map(s => s.boxes['box25'] ?? D('0')));
  const t5Box26Total = sumD(t5s.map(s => s.boxes['box26'] ?? D('0')));

  // T3 slip reconciliation
  const t3s = facts.slips.filter(s => s.slipType === 'T3');
  const t3Box26Total = sumD(t3s.map(s => s.boxes['box26'] ?? D('0')));
  const t3Box49Total = sumD(t3s.map(s => s.boxes['box49'] ?? D('0')));
  const t3Box32Total = sumD(t3s.map(s => s.boxes['box32'] ?? D('0')));

  // Interest L12100 — prefer T5 box 13 + T3 box 26 when slips exist
  const computedInterest = sumD(facts.interestIncome.map(i => i.cadAmount));
  const slipInterest = t5Box13Total.plus(t3Box26Total);
  const hasInterestSlips = t5s.some(s => (s.boxes['box13'] ?? D('0')).greaterThan(0))
    || t3s.some(s => (s.boxes['box26'] ?? D('0')).greaterThan(0));
  const interest = hasInterestSlips ? slipInterest : computedInterest;
  if (hasInterestSlips && slipInterest.minus(computedInterest).abs().greaterThan(50)) {
    warnings.push(
      `T5/T3 interest total $${slipInterest.toFixed(2)} differs from computed interest $${computedInterest.toFixed(2)} by $${slipInterest.minus(computedInterest).abs().toFixed(2)}.`
    );
  }
  push('L12100', 'Interest and other investment income', interest,
    hasInterestSlips
      ? [...t5s.map(s => ({ source: `Slip T5 #${s.slipId} box 13`, amount: s.boxes['box13'] ?? D('0') })),
         ...t3s.map(s => ({ source: `Slip T3 #${s.slipId} box 26`, amount: s.boxes['box26'] ?? D('0') }))]
      : facts.interestIncome.map(i => ({ source: i.source, amount: i.cadAmount })));

  // Eligible dividends L12000 — T5 box 25 / T3 box 49 are already grossed-up (taxable amount)
  const eligibleActual = sumD(facts.eligibleDividends.map(i => i.cadAmount));
  const slipEligibleGrossed = t5Box25Total.plus(t3Box49Total);
  const hasEligibleSlips = t5s.some(s => (s.boxes['box25'] ?? D('0')).greaterThan(0))
    || t3s.some(s => (s.boxes['box49'] ?? D('0')).greaterThan(0));
  const eligibleGrossed = hasEligibleSlips ? slipEligibleGrossed : grossUpEligible(eligibleActual, r);
  if (hasEligibleSlips) {
    const computedGrossed = grossUpEligible(eligibleActual, r);
    if (slipEligibleGrossed.minus(computedGrossed).abs().greaterThan(50)) {
      warnings.push(
        `T5/T3 eligible dividend (taxable) $${slipEligibleGrossed.toFixed(2)} differs from computed grossed-up $${computedGrossed.toFixed(2)}.`
      );
    }
  }
  push('L12000', 'Taxable amount of eligible dividends', eligibleGrossed,
    hasEligibleSlips
      ? [...t5s.map(s => ({ source: `Slip T5 #${s.slipId} box 25`, amount: s.boxes['box25'] ?? D('0') })),
         ...t3s.map(s => ({ source: `Slip T3 #${s.slipId} box 49`, amount: s.boxes['box49'] ?? D('0') }))]
      : facts.eligibleDividends.map(i => ({ source: i.source, amount: i.cadAmount })),
    hasEligibleSlips ? 'from T5/T3 slips (pre-grossed)' : `${r.dividendGrossUpEligible.plus(1).toString()} × actual`);

  // Non-eligible dividends L12010
  const nonElActual = sumD(facts.nonEligibleDividends.map(i => i.cadAmount));
  const slipNonElGrossed = t5Box26Total.plus(t3Box32Total);
  const hasNonElSlips = t5s.some(s => (s.boxes['box26'] ?? D('0')).greaterThan(0))
    || t3s.some(s => (s.boxes['box32'] ?? D('0')).greaterThan(0));
  const nonElGrossed = hasNonElSlips ? slipNonElGrossed : grossUpNonEligible(nonElActual, r);
  if (hasNonElSlips) {
    const computedGrossed = grossUpNonEligible(nonElActual, r);
    if (slipNonElGrossed.minus(computedGrossed).abs().greaterThan(50)) {
      warnings.push(
        `T5/T3 non-eligible dividend (taxable) $${slipNonElGrossed.toFixed(2)} differs from computed grossed-up $${computedGrossed.toFixed(2)}.`
      );
    }
  }
  push('L12010', 'Taxable amount of non-eligible dividends', nonElGrossed,
    hasNonElSlips
      ? [...t5s.map(s => ({ source: `Slip T5 #${s.slipId} box 26`, amount: s.boxes['box26'] ?? D('0') })),
         ...t3s.map(s => ({ source: `Slip T3 #${s.slipId} box 32`, amount: s.boxes['box32'] ?? D('0') }))]
      : facts.nonEligibleDividends.map(i => ({ source: i.source, amount: i.cadAmount })));

  // Capital gains L12700
  const cg = taxableCapitalGains(facts.capitalGainEvents, r, facts.carryforwards.netCapitalLoss);
  push('L12700', 'Taxable capital gains', cg.taxable,
    facts.capitalGainEvents.map((e) => ({
      source: `${e.source} ${e.date}`,
      amount: e.proceeds.minus(e.acb).minus(e.outlays),
    })),
    r.capitalGainsInclusionHigh
      ? `first $${r.capitalGainsInclusionThreshold!.toFixed(0)} × ${r.capitalGainsInclusion.toString()}, excess × ${r.capitalGainsInclusionHigh.toString()} − applied losses`
      : `gross × ${r.capitalGainsInclusion.toString()} − applied losses`);

  for (const e of facts.capitalGainEvents) {
    if (e.superficialLossDenied?.greaterThan(0)) {
      warnings.push(
        `Superficial loss denied: ${e.source} — $${e.superficialLossDenied.toFixed(2)} loss denied (repurchase within 30 days)`
      );
    }
  }

  // Self-employment L13500 = revenue − expenses
  const seRev = sumD(facts.selfEmploymentIncome.map((i) => i.cadAmount));
  const seExp = sumD(facts.selfEmploymentExpenses.map((i) => i.cadAmount));
  const seNet = seRev.minus(seExp);
  push('L13500', 'Self-employment income (net)', seNet,
    [
      ...facts.selfEmploymentIncome.map((i) => ({ source: i.source, amount: i.cadAmount })),
      ...facts.selfEmploymentExpenses.map((i) => ({ source: i.source, amount: i.cadAmount.negated() })),
    ],
    'sum(SE revenue) − sum(SE expenses)');

  // SE CPP — compute immediately after seNet (needed before netIncome)
  const seCppContrib = seNet.greaterThan(0) ? computeCppSelfEmployed(seNet, r) : D('0');

  // Pension income L11500
  const pensionAmt = facts.pensionIncome ?? D('0');
  if (pensionAmt.greaterThan(0)) {
    push('L11500', 'Pension income', pensionAmt, [{ source: 'pension', amount: pensionAmt }]);
  }

  // Rental income L12600 (net of expenses)
  const rentalGross = sumD(facts.rentalIncome.map(i => i.cadAmount));
  const rentalExp = sumD(facts.rentalExpenses.map(i => i.cadAmount));
  const rentalNet = rentalGross.minus(rentalExp);
  if (!rentalNet.equals(0)) {
    push('L12600', 'Net rental income', rentalNet,
      [
        ...facts.rentalIncome.map(i => ({ source: i.source, amount: i.cadAmount })),
        ...facts.rentalExpenses.map(i => ({ source: i.source, amount: i.cadAmount.negated() })),
      ],
      'sum(rental revenue) − sum(rental expenses)');
  }

  // Total income L15000
  const totalIncome = sumD([employmentLine, interest, eligibleGrossed, nonElGrossed, cg.taxable, seNet, pensionAmt, rentalNet]);
  push('L15000', 'Total income', totalIncome);

  // RRSP deduction L20800
  const rrsp = Decimal.min(sumD(facts.rrspContribs.map((c) => c.amount)), facts.carryforwards.rrspRoom);
  push('L20800', 'RRSP deduction', rrsp,
    facts.rrspContribs.map((c) => ({ source: c.source, amount: c.amount })),
    `min(contribs, rrspRoom=${facts.carryforwards.rrspRoom.toFixed(2)})`);

  // FHSA deduction L20805 — capped at annual limit ($8,000)
  const fhsa = Decimal.min(sumD(facts.fhsaContribs.map((c) => c.amount)), r.fhsaAnnualLimit);
  push('L20805', 'FHSA deduction', fhsa,
    facts.fhsaContribs.map((c) => ({ source: c.source, amount: c.amount })),
    `min(fhsaContribs, fhsaAnnualLimit=${r.fhsaAnnualLimit.toFixed(2)})`);

  // SE CPP deductible half L22200 — deductible against net income (employer half)
  const seCppDeductible = seCppContrib.dividedBy(2);
  if (seCppContrib.greaterThan(0)) {
    push('L22200', 'CPP on self-employment (deductible half)', seCppDeductible, [],
      'SE CPP total / 2');
  }

  // Net income L23600
  const netIncome = maxZero(totalIncome.minus(rrsp).minus(fhsa).minus(seCppDeductible));
  push('L23600', 'Net income', netIncome);

  // OAS clawback / social benefits repayment L23500 — computed on net income before adjustments
  const oasRepayment = oasClawback(netIncome, r);
  if (oasRepayment.greaterThan(0)) {
    push('L23500', 'Social benefits repayment (OAS clawback)', oasRepayment, [],
      `15% × max(0, netIncome − ${r.oasClawbackThreshold.toFixed(2)})`);
  }

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
  const seCppEmployeeHalf = seCppContrib.dividedBy(2);
  const cppEiCreditEligible = cppEiCreditAmount(cppEmployee.plus(seCppEmployeeHalf), eiEmployee);
  const fedCreditAmountsTotal = sumD([bpaFedAmt, spousalFedAmt, ageFedAmt, employmentFedAmt, cppEiCreditEligible]);
  const fedNonRefundableLowRatePart = fedCreditAmountsTotal.times(r.donationLowRate);

  // Donations — wire to actual donations facts
  const totalDonations = sumD(facts.donations.map((i) => i.cadAmount));
  const donationsFedCredit = donationCreditFederal(totalDonations, taxableIncome, r);

  // Phase 2 credits — each returns a credit VALUE (already × rate); subtract dollar-for-dollar
  const dtcSelfFedCredit = disabilityCreditFederal(
    facts.disabilityCredit?.selfEligible ?? false, r,
  );
  const caregiverFedCredit = caregiverCreditFederal(
    (facts.caregiverDependents ?? []).map((d) => ({ netIncome: d.netIncome, eligibleAmount: d.eligibleAmount })),
    r,
  );
  const tuitionFedCredit = tuitionCreditFederal(facts.tuitionFees ?? D('0'), r);
  const pensionFedCredit = pensionIncomeCreditFederal(facts.pensionIncome ?? D('0'), r);

  const totalMedical = sumD(facts.medicalExpenses.map(i => i.cadAmount));
  const medicalFedCredit = medicalCreditFederal(totalMedical, netIncome, r);

  // Federal DTC (reduces federal tax dollar-for-dollar in credit-value form)
  const fedDtcEligible = dtcFederal(eligibleGrossed, 'eligible', r);
  const fedDtcNonEligible = dtcFederal(nonElGrossed, 'non_eligible', r);

  const federalTax = maxZero(
    federalTaxBeforeCredits
      .minus(fedNonRefundableLowRatePart)
      .minus(donationsFedCredit)
      .minus(dtcSelfFedCredit)
      .minus(caregiverFedCredit)
      .minus(tuitionFedCredit)
      .minus(pensionFedCredit)
      .minus(medicalFedCredit)
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
      { source: 'Donations credit', amount: donationsFedCredit },
      { source: 'Disability credit (self)', amount: dtcSelfFedCredit },
      { source: 'Caregiver credit', amount: caregiverFedCredit },
      { source: 'Tuition credit', amount: tuitionFedCredit },
      { source: 'Pension income credit', amount: pensionFedCredit },
      { source: 'Medical credit', amount: medicalFedCredit },
      { source: 'DTC eligible', amount: fedDtcEligible },
      { source: 'DTC non-eligible', amount: fedDtcNonEligible },
    ]);

  // Alternative Minimum Tax (AMT) — post-2024 reformed rules
  const amtResult = computeAmt({
    taxableIncome,
    regularFederalTax: federalTax,
    capitalGainsGross: cg.gross,
    capitalGainsTaxable: cg.taxable,
    eligibleDividendsGrossed: eligibleGrossed,
    nonEligibleDividendsGrossed: nonElGrossed,
    totalNonRefundableCredits: fedNonRefundableLowRatePart,
    totalDtcCredits: fedDtcEligible.plus(fedDtcNonEligible),
    rates: r,
  });
  if (amtResult.amtAdditional.greaterThan(0)) {
    push('L41400', 'Additional federal tax — AMT', amtResult.amtAdditional, [],
      `AMT payable $${amtResult.amtPayable.toFixed(2)} exceeds regular federal tax $${federalTax.toFixed(2)}`);
    warnings.push(
      `Alternative Minimum Tax applies: $${amtResult.amtAdditional.toFixed(2)} additional federal tax. ` +
      `AMT base: $${amtResult.amtBase.toFixed(2)} (adjusted taxable income above $${r.amtExemption.toFixed(0)} exemption).`
    );
  }
  const federalTaxWithAmt = federalTax.plus(amtResult.amtAdditional);

  // Ontario tax before credits
  const onTaxBeforeCredits = applyBrackets(taxableIncome, r.provincialBrackets);
  const bpaOnAmt = basicPersonalAmountOntarioApplied(taxableIncome, r);
  const spousalOnAmt = facts.spouse ? spousalCreditOntario(facts.spouse.netIncome, r) : D('0');
  const ageOnAmt = ageCreditOntario(facts.ageAtYearEnd, netIncome, r);
  const onCreditTotal = sumD([bpaOnAmt, spousalOnAmt, ageOnAmt, cppEiCreditEligible]).times(r.provincialBrackets[0].rate);
  const onDonationsCredit = donationCreditOntario(totalDonations, taxableIncome, r);
  const onPensionCredit = pensionIncomeCreditOntario(facts.pensionIncome ?? D('0'), r);
  const onMedicalCredit = medicalCreditOntario(totalMedical, netIncome, r);
  const onDtcEligible = dtcOntario(eligibleGrossed, 'eligible', r);
  const onDtcNonEligible = dtcOntario(nonElGrossed, 'non_eligible', r);
  const onTax = maxZero(
    onTaxBeforeCredits
      .minus(onCreditTotal)
      .minus(onDonationsCredit)
      .minus(onPensionCredit)
      .minus(onMedicalCredit)
      .minus(onDtcEligible)
      .minus(onDtcNonEligible),
  );
  push('L42800', 'Net Ontario tax', onTax);

  // ON surtax + Ontario Health Premium (use rate table arrays)
  const onSurtax = computeOnSurtax(onTax, r);
  const ohp = computeOhp(taxableIncome, r);
  push('L42801', 'ON surtax', onSurtax);
  push('L42802', 'Ontario Health Premium', ohp);

  // SE CPP payable L31000 — both halves owed by SE individual
  if (seCppContrib.greaterThan(0)) {
    push('L31000', 'CPP contributions on self-employment', seCppContrib, [],
      '2 × computeCppEmployee(seNet)');
  }

  // Totals
  const totalPayable = sumD([federalTaxWithAmt, onTax, onSurtax, ohp, oasRepayment, seCppContrib]);
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
      federalTax: federalTaxWithAmt,
      provincialTax: onTax.plus(onSurtax).plus(ohp),
      cppContrib: cppEmployee.plus(seCppContrib),
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
