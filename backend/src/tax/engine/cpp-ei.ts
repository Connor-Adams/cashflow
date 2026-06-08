import { D, Decimal, maxZero } from '../util/decimal';
import type { RateTable } from './types';

export function computeCppEmployee(employmentIncome: Decimal, r: RateTable): Decimal {
  if (employmentIncome.lessThanOrEqualTo(r.cpp.basicExemption)) return D('0');
  const baseBase = Decimal.min(employmentIncome, r.cpp.ympe).minus(r.cpp.basicExemption);
  const baseContrib = maxZero(baseBase).times(r.cpp.employeeRate);
  const cpp2Base = maxZero(
    Decimal.min(employmentIncome, r.cpp.yampe).minus(r.cpp.ympe)
  );
  const cpp2 = cpp2Base.times(r.cpp.cpp2Rate);
  return baseContrib.plus(cpp2);
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
