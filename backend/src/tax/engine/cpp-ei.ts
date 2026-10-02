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

export function computeCppSelfEmployed(selfEmploymentIncome: Decimal, r: RateTable): Decimal {
  if (selfEmploymentIncome.lessThanOrEqualTo(r.cpp.basicExemption)) return D('0');
  const baseBase = Decimal.min(selfEmploymentIncome, r.cpp.ympe).minus(r.cpp.basicExemption);
  const baseContrib = maxZero(baseBase).times(r.cpp.employeeRate);
  const cpp2Base = maxZero(
    Decimal.min(selfEmploymentIncome, r.cpp.yampe).minus(r.cpp.ympe)
  );
  const cpp2 = cpp2Base.times(r.cpp.cpp2Rate);
  const employeePortion = baseContrib.plus(cpp2);
  return employeePortion.times(D('2'));
}
