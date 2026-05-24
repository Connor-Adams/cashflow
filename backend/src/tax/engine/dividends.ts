import { type Decimal } from '../util/decimal';
import type { RateTable } from './types';

export type DividendKind = 'eligible' | 'non_eligible';

export function grossUpEligible(actual: Decimal, r: RateTable): Decimal {
  return actual.times(r.dividendGrossUpEligible.plus(1));
}

export function grossUpNonEligible(actual: Decimal, r: RateTable): Decimal {
  return actual.times(r.dividendGrossUpNonEligible.plus(1));
}

export function dtcFederal(grossedUp: Decimal, kind: DividendKind, r: RateTable): Decimal {
  const rate = kind === 'eligible' ? r.dtcFederalEligible : r.dtcFederalNonEligible;
  return grossedUp.times(rate);
}

export function dtcOntario(grossedUp: Decimal, kind: DividendKind, r: RateTable): Decimal {
  const rate = kind === 'eligible' ? r.dtcOntarioEligible : r.dtcOntarioNonEligible;
  return grossedUp.times(rate);
}
