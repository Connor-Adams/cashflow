import { D, Decimal } from '../util/decimal';
import type { Bracket, RateTable } from './types';
import { RATES_2024 } from '../data/rates-2024';
import { RATES_2025 } from '../data/rates-2025';
import { RATES_2026 } from '../data/rates-2026';

export class RateTableMissingError extends Error {
  constructor(year: number) {
    super(
      `RateTableMissingError: no rate table encoded for year ${year}. Add backend/src/tax/data/rates-${year}.ts.`
    );
    this.name = 'RateTableMissingError';
  }
}

const TABLES: Record<number, RateTable> = {
  2024: RATES_2024,
  2025: RATES_2025,
  2026: RATES_2026,
};

export function ratesFor(year: number): RateTable {
  const t = TABLES[year];
  if (!t) throw new RateTableMissingError(year);
  return t;
}

export function applyBrackets(taxableIncome: Decimal, brackets: Bracket[]): Decimal {
  let remaining = taxableIncome;
  let lowerBound = D('0');
  let tax = D('0');
  for (const b of brackets) {
    if (remaining.lessThanOrEqualTo(0)) break;
    const slice = b.upTo === null ? remaining : Decimal.min(remaining, b.upTo.minus(lowerBound));
    tax = tax.plus(slice.times(b.rate));
    remaining = remaining.minus(slice);
    lowerBound = b.upTo ?? lowerBound;
  }
  return tax;
}
