import Decimal from 'decimal.js';

Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_EVEN });

export { Decimal };

export type DecimalLike = Decimal | string | number;

export function D(v: DecimalLike): Decimal {
  return v instanceof Decimal ? v : new Decimal(v);
}

export function sumD(values: DecimalLike[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(D(v)), new Decimal(0));
}

export function toCents(v: Decimal): number {
  return v.times(100).round().toNumber();
}

export function fromCents(cents: number): Decimal {
  return new Decimal(cents).dividedBy(100);
}

export function maxZero(v: Decimal): Decimal {
  return v.isNegative() ? new Decimal(0) : v;
}
