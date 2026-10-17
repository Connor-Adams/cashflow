/**
 * The share of a business charge that is deductible, as a fraction in [0, 1].
 *
 * `transaction_tax_metadata.deductible_percent` when the row has metadata (meals
 * at 50%, a home-office share, …). Without metadata, a business-flagged charge is
 * fully deductible and anything else is not — the migration's default, and what
 * the hygiene dashboard, the tax reserve and the T1 all assume.
 *
 * One definition for all three readers: they used to hand-roll it, and the T1
 * ignored the declared percent entirely.
 */
export function resolveDeductiblePercent(
  declared: string | number | null | undefined,
  finalBusiness: boolean,
): number {
  const n = declared == null || declared === '' ? NaN : Number(declared);
  if (Number.isNaN(n)) return finalBusiness ? 1 : 0;
  return Math.min(1, Math.max(0, n));
}
