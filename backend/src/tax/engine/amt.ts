import { D, Decimal, maxZero } from '../util/decimal';
import type { RateTable } from './types';

export interface AmtInput {
  taxableIncome: Decimal;
  regularFederalTax: Decimal;
  capitalGainsGross: Decimal;
  capitalGainsTaxable: Decimal;
  eligibleDividendsGrossed: Decimal;
  nonEligibleDividendsGrossed: Decimal;
  totalNonRefundableCredits: Decimal;
  totalDtcCredits: Decimal;
  rates: RateTable;
}

export interface AmtResult {
  amtBase: Decimal;
  amtPayable: Decimal;
  amtAdditional: Decimal;
}

export function computeAmt(input: AmtInput): AmtResult {
  const r = input.rates;

  // Step 1: Adjust taxable income for AMT
  // Add back the capital gains inclusion difference (100% - normal rate)
  const cgAddBack = input.capitalGainsGross.greaterThan(0)
    ? input.capitalGainsGross.times(r.amtCapGainsInclusion).minus(input.capitalGainsTaxable)
    : D('0');

  // Dividends enter the AMT base at their ACTUAL amount: taxable income
  // carries the grossed-up figures, so back the gross-up out.
  const eligibleGrossUp = input.eligibleDividendsGrossed.minus(
    input.eligibleDividendsGrossed.dividedBy(D('1').plus(r.dividendGrossUpEligible)),
  );
  const nonEligibleGrossUp = input.nonEligibleDividendsGrossed.minus(
    input.nonEligibleDividendsGrossed.dividedBy(D('1').plus(r.dividendGrossUpNonEligible)),
  );

  const adjustedTaxableIncome = maxZero(
    input.taxableIncome
      .plus(maxZero(cgAddBack))
      .minus(eligibleGrossUp)
      .minus(nonEligibleGrossUp),
  );

  // Step 2: AMT base = adjusted income minus exemption
  const amtBase = maxZero(adjustedTaxableIncome.minus(r.amtExemption));

  // Step 3: AMT before credits = base × AMT rate
  const amtBeforeCredits = amtBase.times(r.amtRate);

  // Step 4: Allowed credits = fraction of non-refundable credits + fraction of
  // DTC (amtDtcFraction is 0 — the dividend tax credit is fully denied under
  // AMT, matching the gross-up exclusion above)
  const allowedCredits = input.totalNonRefundableCredits.times(r.amtNonRefCreditFraction)
    .plus(input.totalDtcCredits.times(r.amtDtcFraction));

  const amtPayable = maxZero(amtBeforeCredits.minus(allowedCredits));

  // Step 5: Additional AMT = max(0, AMT payable - regular federal tax)
  const amtAdditional = maxZero(amtPayable.minus(input.regularFederalTax));

  return { amtBase, amtPayable, amtAdditional };
}
