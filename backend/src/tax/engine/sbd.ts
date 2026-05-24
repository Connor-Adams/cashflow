import { D, Decimal, maxZero } from '../util/decimal';
import type { RateTable } from './types';

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
