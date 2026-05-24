import { type Decimal } from '../util/decimal';
import type { RateTable } from './types';

export type DividendKind = 'eligible' | 'non_eligible';

export function grossUpEligible(actual: Decimal, r: RateTable): Decimal {
  return actual.times(r.dividendGrossUpEligible.plus(1));
}

export function grossUpNonEligible(actual: Decimal, r: RateTable): Decimal {
  return actual.times(r.dividendGrossUpNonEligible.plus(1));
}

function assertNeverKind(kind: never): never {
  throw new Error(`Unhandled DividendKind: ${String(kind)}`);
}

export function dtcFederal(grossedUp: Decimal, kind: DividendKind, r: RateTable): Decimal {
  switch (kind) {
    case 'eligible':
      return grossedUp.times(r.dtcFederalEligible);
    case 'non_eligible':
      return grossedUp.times(r.dtcFederalNonEligible);
    default:
      return assertNeverKind(kind);
  }
}

export function dtcOntario(grossedUp: Decimal, kind: DividendKind, r: RateTable): Decimal {
  switch (kind) {
    case 'eligible':
      return grossedUp.times(r.dtcOntarioEligible);
    case 'non_eligible':
      return grossedUp.times(r.dtcOntarioNonEligible);
    default:
      return assertNeverKind(kind);
  }
}
