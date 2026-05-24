import { D, Decimal, maxZero } from '../util/decimal';
import type { RateTable } from './types';

// ─── Federal credits ──────────────────────────────────────────────────────────

/** BPA grant amount (the deduction-equivalent amount), federal, with high-income phaseout. */
export function basicPersonalAmountFederalApplied(
  taxableIncome: Decimal,
  r: RateTable,
): Decimal {
  if (taxableIncome.lessThanOrEqualTo(r.bpaFederalPhaseoutStart)) {
    return r.basicPersonalAmountFederal;
  }
  if (taxableIncome.greaterThanOrEqualTo(r.bpaFederalPhaseoutEnd)) {
    return r.bpaFederalMin;
  }
  const phaseRange = r.bpaFederalPhaseoutEnd.minus(r.bpaFederalPhaseoutStart);
  const above = taxableIncome.minus(r.bpaFederalPhaseoutStart);
  const reduction = r.basicPersonalAmountFederal
    .minus(r.bpaFederalMin)
    .times(above.dividedBy(phaseRange));
  return r.basicPersonalAmountFederal.minus(reduction);
}

/** Returns the credit *amount* (eligible amount), not the credit value. Caller multiplies by lowest rate. */
export function spousalCreditFederal(spouseNetIncome: Decimal, r: RateTable): Decimal {
  return maxZero(r.spousalAmountFederal.minus(spouseNetIncome));
}

export function ageCreditFederal(
  ageAtYearEnd: number,
  netIncome: Decimal,
  r: RateTable,
): Decimal {
  if (ageAtYearEnd < r.ageAmountAge) return D('0');
  if (netIncome.lessThanOrEqualTo(r.ageAmountFederalThreshold)) return r.ageAmountFederal;
  const reduction = netIncome.minus(r.ageAmountFederalThreshold).times(r.ageAmountFederalClawbackRate);
  return maxZero(r.ageAmountFederal.minus(reduction));
}

/** Returns the donation tax credit *value* (not the eligible amount). */
export function donationCreditFederal(
  totalDonations: Decimal,
  taxableIncome: Decimal,
  r: RateTable,
): Decimal {
  const low = Decimal.min(totalDonations, r.donationHighRateThreshold);
  const high = maxZero(totalDonations.minus(r.donationHighRateThreshold));
  // High-rate portion is 33% only on amounts that would otherwise be taxed at 33%
  // (i.e., portion of taxable income above the top federal bracket threshold).
  // Approximation per CRA: 33% applies to lesser-of(high portion, taxable income above top bracket).
  // federalBrackets last item is the open-ended top bracket; second-to-last upTo is the threshold.
  const topBracketCap = r.federalBrackets[r.federalBrackets.length - 2].upTo ?? D('0');
  const aboveTop = maxZero(taxableIncome.minus(topBracketCap));
  const at33 = Decimal.min(high, aboveTop);
  const at29 = high.minus(at33);
  return low
    .times(r.donationLowRate)
    .plus(at29.times(r.donationHighRateFederal))
    .plus(at33.times(D('0.33')));
}

// ─── Ontario credits ──────────────────────────────────────────────────────────

/** Ontario BPA — no phaseout, constant for all income levels. */
export function basicPersonalAmountOntarioApplied(
  _taxableIncome: Decimal,
  r: RateTable,
): Decimal {
  return r.basicPersonalAmountOntario;
}

export function spousalCreditOntario(spouseNetIncome: Decimal, r: RateTable): Decimal {
  return maxZero(r.spousalAmountOntario.minus(spouseNetIncome));
}

export function ageCreditOntario(
  ageAtYearEnd: number,
  netIncome: Decimal,
  r: RateTable,
): Decimal {
  if (ageAtYearEnd < r.ageAmountAge) return D('0');
  if (netIncome.lessThanOrEqualTo(r.ageAmountOntarioThreshold)) return r.ageAmountOntario;
  const reduction = netIncome.minus(r.ageAmountOntarioThreshold).times(r.ageAmountOntarioClawbackRate);
  return maxZero(r.ageAmountOntario.minus(reduction));
}

/**
 * Ontario donation credit value.
 * ON does not have a special top-bracket rate — amounts above $200 use donationHighRateOntario (11.16%).
 */
export function donationCreditOntario(
  totalDonations: Decimal,
  _taxableIncome: Decimal,
  r: RateTable,
): Decimal {
  const low = Decimal.min(totalDonations, r.donationHighRateThreshold);
  const high = maxZero(totalDonations.minus(r.donationHighRateThreshold));
  return low.times(r.donationLowRateOntario).plus(high.times(r.donationHighRateOntario));
}

// ─── Employment, CPP/EI, Medical ─────────────────────────────────────────────

export function employmentAmountFederalApplied(
  employmentIncome: Decimal,
  r: RateTable,
): Decimal {
  return Decimal.min(employmentIncome, r.employmentAmountFederal);
}

export function cppEiCreditAmount(cppContrib: Decimal, eiPremium: Decimal): Decimal {
  return cppContrib.plus(eiPremium);
}

export function medicalCreditFederal(
  medicalExpenses: Decimal,
  netIncome: Decimal,
  r: RateTable,
): Decimal {
  const threshold = Decimal.min(
    netIncome.times(r.medicalThresholdPercent),
    r.medicalThresholdCap,
  );
  const eligible = maxZero(medicalExpenses.minus(threshold));
  return eligible.times(r.donationLowRate); // federal lowest rate = 15%
}
