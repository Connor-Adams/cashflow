import { D, Decimal, maxZero } from '../util/decimal';
import type { RateTable } from './types';

/**
 * The base CPP rate (employee share), unchanged since 2003. Everything above it in
 * `cpp.employeeRate` is the "first additional" contribution phased in from 2019 —
 * part of enhanced CPP, which is deducted on L22215 rather than credited on L30800.
 */
const CPP_BASE_RATE = D('0.0495');

/**
 * Employee CPP split the way the T4 reports it: `firstTier` is box 16 (base plus
 * first additional, up to the YMPE), `cpp2` is box 16A (second additional, YMPE to
 * YAMPE).
 */
export function computeCppEmployeeParts(
  employmentIncome: Decimal,
  r: RateTable,
): { firstTier: Decimal; cpp2: Decimal } {
  if (employmentIncome.lessThanOrEqualTo(r.cpp.basicExemption)) {
    return { firstTier: D('0'), cpp2: D('0') };
  }
  const baseBase = Decimal.min(employmentIncome, r.cpp.ympe).minus(r.cpp.basicExemption);
  const firstTier = maxZero(baseBase).times(r.cpp.employeeRate);
  const cpp2Base = maxZero(
    Decimal.min(employmentIncome, r.cpp.yampe).minus(r.cpp.ympe)
  );
  return { firstTier, cpp2: cpp2Base.times(r.cpp.cpp2Rate) };
}

export function computeCppEmployee(employmentIncome: Decimal, r: RateTable): Decimal {
  const { firstTier, cpp2 } = computeCppEmployeeParts(employmentIncome, r);
  return firstTier.plus(cpp2);
}

/**
 * Enhanced CPP on employment income (L22215): the first-additional share of the
 * first-tier contribution, plus all of CPP2. The remainder of the first tier is base
 * CPP, the only part that earns the L30800 credit.
 */
export function enhancedCppDeduction(firstTier: Decimal, cpp2: Decimal, r: RateTable): Decimal {
  const firstAdditionalRate = maxZero(r.cpp.employeeRate.minus(CPP_BASE_RATE));
  const firstAdditional = r.cpp.employeeRate.greaterThan(0)
    ? firstTier.times(firstAdditionalRate).dividedBy(r.cpp.employeeRate)
    : D('0');
  return firstAdditional.plus(cpp2);
}

export function computeEiEmployee(employmentIncome: Decimal, r: RateTable): Decimal {
  const base = Decimal.min(employmentIncome, r.ei.maxInsurable);
  return base.times(r.ei.employeeRate);
}

/**
 * Self-employed CPP, split the way CRA Schedule 8 (5000-S8) Part 4 splits it.
 * The self-employed pay both shares, so every amount is twice the employee one:
 *
 *   - `total` → L42100, payable with the return (S8 Part 4 line 14).
 *   - `base` (9.9%) — half is credited on L31000 (line 15), half deducted.
 *   - `enhanced` — the first-additional share of the first tier (2% of 11.9%,
 *     i.e. 1/5.95 of the contribution rate, the same split `enhancedCppDeduction`
 *     makes for a T4) plus all of CPP2 (8%). Both shares are deductible.
 *
 * Unlike employment income, the enhanced share does NOT go on L22215: Schedule 8
 * Part 4 adds it to the employer half of base and sends the sum to L22200
 * (line 17 = line 15 + line 16). L22215 is enhanced CPP on employment income only
 * (Part 3 lines 28/48). CRA, "The Canada Pension Plan enhancement" (2023-05): the
 * self-employed claim a credit on 4.95% of base, deduct the other 4.95%, and
 * deduct the 2% enhanced portion and all CPP2.
 */
export function computeCppSelfEmployedParts(
  selfEmploymentIncome: Decimal,
  r: RateTable,
): { total: Decimal; base: Decimal; enhanced: Decimal } {
  const { firstTier, cpp2 } = computeCppEmployeeParts(selfEmploymentIncome, r);
  const total = firstTier.plus(cpp2).times(2);
  const enhanced = enhancedCppDeduction(firstTier.times(2), cpp2.times(2), r);
  return { total, base: total.minus(enhanced), enhanced };
}

export function computeCppSelfEmployed(selfEmploymentIncome: Decimal, r: RateTable): Decimal {
  return computeCppSelfEmployedParts(selfEmploymentIncome, r).total;
}
