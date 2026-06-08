/**
 * SQLite DECIMAL values often arrive as strings on reads.
 */
export function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/**
 * Integer-unit scaling factor for accumulation arithmetic.
 *
 * JavaScript IEEE-754 doubles drift when thousands of fractional-cent
 * amounts are summed with `+=`. Converting to integer units before
 * accumulating and dividing back at the output boundary eliminates the
 * drift. 10 000 matches the DB's DECIMAL(14,4) precision.
 *
 * Usage:
 *   accumulator += toUnits(amount);   // inside the loop
 *   result.total = fromUnits(accumulator); // at the serialization boundary
 */
export const UNITS = 10_000;

/** Multiply a dollar amount to integer units for drift-free accumulation. */
export function toUnits(n: number): number {
  return Math.round(n * UNITS);
}

/** Convert integer units back to dollars at the output boundary. */
export function fromUnits(n: number): number {
  return n / UNITS;
}
