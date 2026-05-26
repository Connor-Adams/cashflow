/**
 * CRA prescribed RRIF minimum-withdrawal table (Income Tax Regulation 7308 /
 * Schedule 2). For a RRIF holder who turns N in the calendar year, the
 * minimum required withdrawal for the year is `balance × rrifMinPercent(N)`,
 * where the balance is the FMV of the RRIF on January 1.
 *
 * Ages < 71 → 0 (no mandatory minimum; voluntary withdrawals only).
 * Ages 71–94 → fixed schedule below.
 * Ages 95+ → 20% (flat).
 *
 * Reference-only helper for P12 retirement projections — users plug the result
 * into `income.pensionIncome` overrides per projected year. Pure numbers (not
 * Decimal) — RRIF % math is approximate by nature and doesn't need bigint
 * precision.
 */

const RRIF_MIN_TABLE: Readonly<Record<number, number>> = Object.freeze({
  71: 0.0528,
  72: 0.054,
  73: 0.0553,
  74: 0.0567,
  75: 0.0582,
  76: 0.0598,
  77: 0.0617,
  78: 0.0636,
  79: 0.0658,
  80: 0.0682,
  81: 0.0708,
  82: 0.0738,
  83: 0.0771,
  84: 0.0808,
  85: 0.0851,
  86: 0.0899,
  87: 0.0955,
  88: 0.1021,
  89: 0.1099,
  90: 0.1192,
  91: 0.1306,
  92: 0.1449,
  93: 0.1634,
  94: 0.1879,
});

const RRIF_MIN_95_PLUS = 0.2;

/**
 * Returns the CRA prescribed minimum withdrawal percentage for a RRIF holder
 * of the given age (age attained in the calendar year). Returns 0 for ages
 * < 71 (no mandatory minimum) and 0.20 for ages ≥ 95.
 */
export function rrifMinPercent(age: number): number {
  if (!Number.isFinite(age)) {
    throw new TypeError(`rrifMinPercent: age must be a finite number, got ${age}`);
  }
  if (age < 71) return 0;
  if (age >= 95) return RRIF_MIN_95_PLUS;
  const pct = RRIF_MIN_TABLE[Math.floor(age)];
  // Defensive: the table covers 71..94 inclusive, so this branch is
  // unreachable for finite integer-coercible ages in range. Guard anyway so a
  // future table edit can't silently return undefined.
  if (pct === undefined) {
    throw new Error(`rrifMinPercent: no entry for age ${age}`);
  }
  return pct;
}

/**
 * Convenience wrapper: minimum required RRIF withdrawal in CAD = balance ×
 * rrifMinPercent(age). Returns 0 for ages < 71.
 */
export function rrifMinWithdrawal(age: number, balance: number): number {
  if (!Number.isFinite(balance)) {
    throw new TypeError(`rrifMinWithdrawal: balance must be a finite number, got ${balance}`);
  }
  return balance * rrifMinPercent(age);
}
