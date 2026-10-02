import { D, Decimal, sumD, maxZero } from '../util/decimal';
import type { RateTable, SlipFact, TaxLine, TaxReturn, TaxYearFacts } from './types';
import { applyBrackets } from './brackets';
import { computeAmt } from './amt';
import {
  computeCppEmployeeParts,
  computeEiEmployee,
  computeCppSelfEmployed,
  enhancedCppDeduction,
} from './cpp-ei';
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
  const warnings: string[] = [...(facts.factWarnings ?? [])];
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

  // Employment income L10100 — prefer T4 box 14 totals over computed txns.
  const t4s = facts.slips.filter((s) => s.slipType === 'T4');
  const t4Box14Total = sumD(t4s.map((s) => s.boxes['box14'] ?? D('0')));
  const computedEmployment = sumD(facts.employmentIncome.map((i) => i.cadAmount));
  // Employment transactions are pay DEPOSITS, i.e. box 14 net of what was held
  // back. Comparing them with gross box 14 made this warning fire on every return.
  const t4NetPay = t4Box14Total.minus(sumD(t4s.map(t4PayrollDeductions)));
  if (t4s.length > 0 && t4NetPay.minus(computedEmployment).abs().greaterThan(50)) {
    warnings.push(
      `T4 net pay $${t4NetPay.toFixed(2)} (box 14 less boxes 16, 16A, 18, 20, 22, 40 and 44) `
      + `differs from employment deposits $${computedEmployment.toFixed(2)} by more than $50.`
    );
  }
  // Plan-scoped additions (routed ownerComp salary) are covered by no T4 slip,
  // so they ride on top of the slip-vs-computed preference instead of being
  // discarded by it. The >$50 reconciliation warning above compares actuals only.
  const employmentAdditions = facts.employmentIncomeAdditions ?? [];
  const employmentAdditionsTotal = sumD(employmentAdditions.map((i) => i.cadAmount));
  const employmentLine = (t4s.length > 0 ? t4Box14Total : computedEmployment)
    .plus(employmentAdditionsTotal);
  push('L10100', 'Employment income', employmentLine,
    [
      ...(t4s.length > 0
        ? t4s.map((s) => ({ source: `Slip T4 #${s.slipId} box 14`, amount: s.boxes['box14'] ?? D('0') }))
        : facts.employmentIncome.map((i) => ({ source: i.source, amount: i.cadAmount }))),
      ...employmentAdditions.map((i) => ({ source: i.source, amount: i.cadAmount })),
    ],
    t4s.length > 0 ? 'sum(T4.box14) + additions' : 'sum(employmentTransactions.cad) + additions'
  );

  // T5 slip reconciliation: prefer slip amounts when present
  const t5s = facts.slips.filter(s => s.slipType === 'T5');
  const t5Box13Total = sumD(t5s.map(s => s.boxes['box13'] ?? D('0')));
  const t5Box25Total = sumD(t5s.map(s => s.boxes['box25'] ?? D('0')));
  // CRA T5 box 11 is the TAXABLE amount of dividends other than eligible. Box 26
  // is the dividend tax credit for ELIGIBLE dividends — reading it here both put a
  // ~15% credit figure on the non-eligible income line and suppressed the computed
  // dividends entirely, which for an owner-managed corp is tens of thousands.
  const t5Box11Total = sumD(t5s.map(s => s.boxes['box11'] ?? D('0')));

  // T3 slip reconciliation
  const t3s = facts.slips.filter(s => s.slipType === 'T3');
  const t3Box26Total = sumD(t3s.map(s => s.boxes['box26'] ?? D('0')));
  // CRA T3 box 50 is the TAXABLE amount of eligible dividends; box 49 is the
  // actual amount. Taking box 49 understated eligible dividends by the 38% gross-up.
  const t3Box50Total = sumD(t3s.map(s => s.boxes['box50'] ?? D('0')));
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

  // Eligible dividends L12000 — T5 box 25 / T3 box 50 are already grossed-up (taxable amount)
  const eligibleActual = sumD(facts.eligibleDividends.map(i => i.cadAmount));
  const slipEligibleGrossed = t5Box25Total.plus(t3Box50Total);
  const hasEligibleSlips = t5s.some(s => (s.boxes['box25'] ?? D('0')).greaterThan(0))
    || t3s.some(s => (s.boxes['box50'] ?? D('0')).greaterThan(0));
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
         ...t3s.map(s => ({ source: `Slip T3 #${s.slipId} box 50`, amount: s.boxes['box50'] ?? D('0') }))]
      : facts.eligibleDividends.map(i => ({ source: i.source, amount: i.cadAmount })),
    hasEligibleSlips ? 'from T5/T3 slips (pre-grossed)' : `${r.dividendGrossUpEligible.plus(1).toString()} × actual`);

  // Non-eligible dividends L12010
  const nonElActual = sumD(facts.nonEligibleDividends.map(i => i.cadAmount));
  const slipNonElGrossed = t5Box11Total.plus(t3Box32Total);
  // Gated on the boxes actually read. Gating on box 26 meant a pure non-eligible
  // T5 — boxes 10/11/12, box 26 empty — never triggered the reconciliation at all,
  // so the slip was decorative and no warning could fire.
  const hasNonElSlips = t5s.some(s => (s.boxes['box11'] ?? D('0')).greaterThan(0))
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
      ? [...t5s.map(s => ({ source: `Slip T5 #${s.slipId} box 11`, amount: s.boxes['box11'] ?? D('0') })),
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

  // Pension income L11500. May be negative when a pension-split transfer-out
  // (deduction L21000 on a real T1) exceeds pension actuals — the net effect
  // on income is identical, but credits below must floor at zero.
  const pensionAmt = facts.pensionIncome ?? D('0');
  if (pensionAmt.greaterThan(0)) {
    push('L11500', 'Pension income', pensionAmt, [{ source: 'pension', amount: pensionAmt }]);
  }

  // CPP/QPP retirement benefits L11400 and OAS pension L11300 — fully taxable
  // ordinary income, but NOT pensionable or insurable earnings: they attract no
  // CPP contributions, EI premiums, or Canada employment amount, and are not
  // eligible pension income for the pension credit.
  const cppBenefits = facts.cppBenefits ?? D('0');
  if (cppBenefits.greaterThan(0)) {
    push('L11400', 'CPP/QPP benefits', cppBenefits, [{ source: 'CPP/QPP benefits', amount: cppBenefits }]);
  }
  const oasBenefits = facts.oasBenefits ?? D('0');
  if (oasBenefits.greaterThan(0)) {
    push('L11300', 'OAS pension', oasBenefits, [{ source: 'OAS pension', amount: oasBenefits }]);
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
  const totalIncome = sumD([employmentLine, interest, eligibleGrossed, nonElGrossed, cg.taxable, seNet, pensionAmt, cppBenefits, oasBenefits, rentalNet]);
  push('L15000', 'Total income', totalIncome);

  // RRSP deduction L20800
  const rrsp = Decimal.min(sumD(facts.rrspContribs.map((c) => c.amount)), facts.carryforwards.rrspRoom);
  push('L20800', 'RRSP deduction', rrsp,
    facts.rrspContribs.map((c) => ({ source: c.source, amount: c.amount })),
    `min(contribs, rrspRoom=${facts.carryforwards.rrspRoom.toFixed(2)})`);

  // FHSA deduction L20805 — bounded by stored participation room, which the roll
  // accumulates and already bounds by the $40k lifetime cap. Capping at the annual
  // limit here lost a carried-forward year: a contributor who skipped 2026 has
  // $16,000 available in 2027 and could only ever deduct $8,000.
  //
  // A zero stored room is ambiguous: it is what the roll writes when it has never run
  // for this entity, AND what it writes once the $40,000 lifetime cap is exhausted
  // (`rollPersonalCarryforwards` bounds room by `lifetimeRemaining`). Falling back to
  // the annual limit on both readings re-granted $8,000 a year to a contributor who
  // had no room left — understating tax by $8,000 x marginal rate, every year.
  //
  // Lifetime contributions disambiguate it, and the fallback is bounded by whatever
  // remains of the cap rather than by the annual limit alone.
  const lifetimeRemaining = maxZero(
    r.fhsaLifetimeLimit.minus(facts.carryforwards.fhsaLifetimeContributions),
  );
  const fhsaRoom = facts.carryforwards.fhsaRoom.greaterThan(0)
    ? facts.carryforwards.fhsaRoom
    : Decimal.min(r.fhsaAnnualLimit, lifetimeRemaining);
  const fhsa = Decimal.min(sumD(facts.fhsaContribs.map((c) => c.amount)), fhsaRoom);
  push('L20805', 'FHSA deduction', fhsa,
    facts.fhsaContribs.map((c) => ({ source: c.source, amount: c.amount })),
    `min(fhsaContribs, fhsaRoom=${fhsaRoom.toFixed(2)})`);

  // SE CPP deductible half L22200 — deductible against net income (employer half)
  const seCppDeductible = seCppContrib.dividedBy(2);
  if (seCppContrib.greaterThan(0)) {
    push('L22200', 'CPP on self-employment (deductible half)', seCppDeductible, [],
      'SE CPP total / 2');
  }

  // Employee CPP and EI. A T4 is the record of what was actually deducted from pay,
  // so its boxes win: box 16 (CPP), 16A (CPP2), 18 (EI). A T4 without box 18 means
  // insurable earnings were nil (e.g. employment by a related person), so EI is
  // zero — recomputing it from box 14 would invent a premium that was never paid.
  // Only with no T4 at all are contributions computed from the employment line.
  const employeeCpp = employeeCppAndEi(t4s, t4Box14Total, employmentLine, employmentAdditionsTotal, r);
  const cppEmployee = employeeCpp.firstTier.plus(employeeCpp.cpp2);
  const eiEmployee = employeeCpp.ei;
  // Enhanced CPP L22215 — deducted, not credited (L30800 takes base CPP only).
  const enhancedCpp = enhancedCppDeduction(employeeCpp.firstTier, employeeCpp.cpp2, r);
  if (enhancedCpp.greaterThan(0)) {
    push('L22215', 'Deduction for CPP enhanced contributions on employment income', enhancedCpp,
      [], 'first-additional share of CPP + CPP2');
  }
  const baseCppEmployee = cppEmployee.minus(enhancedCpp);

  // Net income L23600
  const netIncome = maxZero(
    totalIncome.minus(rrsp).minus(fhsa).minus(seCppDeductible).minus(enhancedCpp),
  );
  push('L23600', 'Net income', netIncome);

  // OAS clawback / social benefits repayment L23500 — computed on net income
  // before adjustments, capped at the OAS benefits actually received.
  const oasRepayment = oasClawback(netIncome, oasBenefits, r);
  if (oasRepayment.greaterThan(0)) {
    push('L23500', 'Social benefits repayment (OAS clawback)', oasRepayment, [],
      `min(OAS received, 15% × max(0, netIncome − ${r.oasClawbackThreshold.toFixed(2)}))`);
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
  const seCppEmployeeHalf = seCppContrib.dividedBy(2);
  const cppEiCreditEligible = cppEiCreditAmount(baseCppEmployee.plus(seCppEmployeeHalf), eiEmployee);
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
  const pensionFedCredit = pensionIncomeCreditFederal(maxZero(pensionAmt), r);

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
  const onPensionCredit = pensionIncomeCreditOntario(maxZero(pensionAmt), r);
  const onMedicalCredit = medicalCreditOntario(totalMedical, netIncome, r);
  const onDtcEligible = dtcOntario(eligibleGrossed, 'eligible', r);
  const onDtcNonEligible = dtcOntario(nonElGrossed, 'non_eligible', r);
  // ON428 ordering (since 2014): the surtax is computed on Ontario tax net of
  // non-refundable credits but BEFORE the Ontario dividend tax credit; the ON
  // DTC is deducted after the surtax lines.
  const onTaxAfterCredits = maxZero(
    onTaxBeforeCredits
      .minus(onCreditTotal)
      .minus(onDonationsCredit)
      .minus(onPensionCredit)
      .minus(onMedicalCredit),
  );
  const onSurtax = computeOnSurtax(onTaxAfterCredits, r);
  const onTax = maxZero(
    onTaxAfterCredits.plus(onSurtax).minus(onDtcEligible).minus(onDtcNonEligible),
  );
  push('L42800', 'Net Ontario tax', onTax);

  // Ontario Health Premium (uses rate table arrays)
  const ohp = computeOhp(taxableIncome, r);
  push('L42801', 'ON surtax', onSurtax);
  push('L42802', 'Ontario Health Premium', ohp);

  // SE CPP payable L31000 — both halves owed by SE individual
  if (seCppContrib.greaterThan(0)) {
    push('L31000', 'CPP contributions on self-employment', seCppContrib, [],
      '2 × computeCppEmployee(seNet)');
  }

  // Totals — onTax already includes the surtax (added before the DTC above)
  const totalPayable = sumD([federalTaxWithAmt, onTax, ohp, oasRepayment, seCppContrib]);
  push('L43500', 'Total payable', totalPayable);

  // Tax deducted at source: every slip that carries a withholding box, not just
  // the T4 — a pension or other-income T4A withholds in box 022.
  const withheld = facts.slips.flatMap((s) => {
    const keys = WITHHOLDING_BOXES[s.slipType];
    if (!keys) return [];
    const found = keys.find((k) => s.boxes[k] !== undefined);
    return found ? [{ source: `Slip ${s.slipType} #${s.slipId} ${found}`, amount: s.boxes[found] }] : [];
  });
  const taxDeductedAtSource = sumD(withheld.map((w) => w.amount));
  push('L43700', 'Total income tax deducted', taxDeductedAtSource, withheld,
    'sum(T4.box22 + T4A.box022)');

  const instalmentsPaid = facts.carryforwards.instalmentsPaid;
  // Its own line. The CRA instalment-threshold test is defined on net tax owing
  // BEFORE instalments are credited — crediting them first would let paying
  // instalments remove the obligation to pay them — and there was no line isolating
  // them to read.
  push('L47600', 'Instalments paid', instalmentsPaid);
  const totalCredits = taxDeductedAtSource.plus(instalmentsPaid);
  push('L48200', 'Total credits (tax deducted + instalments)', totalCredits);

  /**
   * Net tax owing for the CRA instalment test: payable less tax withheld at source,
   * and NOT less instalments. Signed — a negative is a refund, and on a rising-income
   * year the sign is what the two-year test reads.
   */
  const netTaxOwing = totalPayable.minus(taxDeductedAtSource);

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
      provincialTax: onTax.plus(ohp),
      cppContrib: cppEmployee.plus(seCppContrib),
      eiPremium: eiEmployee,
      totalPayable,
      netTaxOwing,
      refundOrOwing,
    },
    warnings,
  };
}

/**
 * Box holding income tax deducted, per slip type. Alternatives are spellings of
 * the same box (slips are entered by hand as `box022` or `box22`); only the
 * first present is read so an alias never counts twice. T5, T3 and T5008 carry
 * no withholding for a resident.
 */
const WITHHOLDING_BOXES: Partial<Record<SlipFact['slipType'], string[]>> = {
  T4: ['box22'],
  T4A: ['box022', 'box22'],
};

function slipBox(s: SlipFact, ...keys: string[]): Decimal {
  for (const k of keys) {
    const v = s.boxes[k];
    if (v !== undefined) return v;
  }
  return D('0');
}

/** Amounts in box 14 that never reach the bank: withholdings plus taxable benefits. */
function t4PayrollDeductions(s: SlipFact): Decimal {
  return sumD([
    slipBox(s, 'box16'), slipBox(s, 'box16A', 'box16a'), slipBox(s, 'box18'),
    slipBox(s, 'box20'), slipBox(s, 'box22'), slipBox(s, 'box40'), slipBox(s, 'box44'),
  ]);
}

/**
 * Employee CPP (split into first tier and CPP2) and EI. From the T4 boxes when
 * any T4 exists; computed only when none does. Plan-scoped additions sit on no
 * slip, so their incremental CPP is computed on top — and incremental EI only
 * when the T4 shows the employment is insurable at all.
 */
function employeeCppAndEi(
  t4s: SlipFact[],
  box14Total: Decimal,
  employmentLine: Decimal,
  additionsTotal: Decimal,
  r: RateTable,
): { firstTier: Decimal; cpp2: Decimal; ei: Decimal } {
  if (t4s.length === 0) {
    const parts = computeCppEmployeeParts(employmentLine, r);
    return { ...parts, ei: computeEiEmployee(employmentLine, r) };
  }
  const slipFirstTier = sumD(t4s.map((s) => slipBox(s, 'box16')));
  const slipCpp2 = sumD(t4s.map((s) => slipBox(s, 'box16A', 'box16a')));
  const slipEi = sumD(t4s.map((s) => slipBox(s, 'box18')));
  if (!additionsTotal.greaterThan(0)) return { firstTier: slipFirstTier, cpp2: slipCpp2, ei: slipEi };
  const before = computeCppEmployeeParts(box14Total, r);
  const after = computeCppEmployeeParts(box14Total.plus(additionsTotal), r);
  const extraEi = slipEi.greaterThan(0)
    ? maxZero(computeEiEmployee(box14Total.plus(additionsTotal), r).minus(computeEiEmployee(box14Total, r)))
    : D('0');
  return {
    firstTier: slipFirstTier.plus(maxZero(after.firstTier.minus(before.firstTier))),
    cpp2: slipCpp2.plus(maxZero(after.cpp2.minus(before.cpp2))),
    ei: slipEi.plus(extraEi),
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
