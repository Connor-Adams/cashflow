import { D, type Decimal } from './decimal';

/**
 * A tax-slip box value as a Decimal, or null when it is not a number.
 *
 * Slips are typed in by hand from the paper form, which prints "1,200.50" — and
 * `D("1,200.50")` throws, taking the whole return down. Thousands separators, a
 * leading dollar sign and surrounding whitespace are accepted; anything else is
 * rejected rather than guessed at.
 */
export function parseSlipAmount(v: unknown): Decimal | null {
  if (typeof v === 'number') return Number.isFinite(v) ? D(v) : null;
  if (typeof v !== 'string') return null;
  const cleaned = v.trim().replace(/^\$/, '').replace(/,/g, '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return D(cleaned);
}
