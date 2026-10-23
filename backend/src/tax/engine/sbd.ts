import { Decimal, maxZero } from '../util/decimal';
import type { CorpFiscalYear, RateTable } from './types';

/**
 * SBD-eligible income = min(ABI, $500k limit reduced by AAII grind).
 * Grind: limit -= max(0, (AAII - $50k) × $5)
 */
export function sbdEligibleIncome(abi: Decimal, aaii: Decimal, r: RateTable): {
  limit: Decimal;
  eligible: Decimal;
  generalRate: Decimal;
} {
  const grind = maxZero(aaii.minus(r.corpAaiiGrindThreshold)).times(r.corpAaiiGrindRate);
  const limit = maxZero(r.corpSbdAnnualLimit.minus(grind));
  const eligible = Decimal.min(abi, limit);
  const generalRate = maxZero(abi.minus(eligible));
  return { limit, eligible, generalRate };
}

const DAY_MS = 86_400_000;
const dayNumber = (isoDate: string) => Date.parse(`${isoDate}T00:00:00Z`) / DAY_MS;

/**
 * The Ontario small business rate for one taxation year. Ontario prorates a
 * rate change by days (Taxation Act, 2007 s.31(4)): each rate applies to the
 * share of the year's days it covers. The 2026-07-01 cut (3.2% → 2.2%) blends
 * a Dec-31 2026 year end to about 2.70%.
 */
export function ontarioSbdRate(fiscalYear: CorpFiscalYear, r: RateTable): Decimal {
  const change = r.corpAbiSbdRateOntarioChange;
  if (!change) return r.corpAbiSbdRateOntario;
  const start = dayNumber(fiscalYear.startDate);
  const end = dayNumber(fiscalYear.endDate);
  const effective = dayNumber(change.effective);
  if (end < effective) return r.corpAbiSbdRateOntario;
  if (start >= effective) return change.rate;
  const totalDays = end - start + 1;
  const daysAfter = end - effective + 1;
  return r.corpAbiSbdRateOntario.times(totalDays - daysAfter)
    .plus(change.rate.times(daysAfter))
    .dividedBy(totalDays);
}
