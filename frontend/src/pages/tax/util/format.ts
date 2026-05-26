// Shared number/string coercion + formatters for the tax pages.
//
// Pulled out so OverviewTab, OwnerCompLeverSurface, and friends share one
// implementation. Previously each file inlined its own near-identical
// `sumStrings` / `numericTotal` / `fmtCurrency`, each with enough branching
// to push it over fallow's CRAP threshold.

export type Numeric = string | number | undefined | null;

// NaN-on-bad-input coercion. Used as the single building block for the
// helpers below so each one only adds a small branch on top.
export function parseFinite(value: Numeric): number {
  if (value == null) return NaN;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : NaN;
}

// Sum a list of numeric-ish values, ignoring non-finite entries.
export function sumNumeric(values: Numeric[]): number {
  return values.reduce<number>((acc, v) => {
    const n = parseFinite(v);
    return Number.isFinite(n) ? acc + n : acc;
  }, 0);
}

// Coerce one value to a finite number; non-finite -> 0. Use when you need
// "missing == 0" semantics for inline arithmetic.
export function numericOrZero(value: Numeric): number {
  const n = parseFinite(value);
  return Number.isFinite(n) ? n : 0;
}

// $X.XX, "—" on non-finite. Accepts string-or-number for raw API totals.
export function fmtCurrency(value: Numeric): string {
  const n = parseFinite(value);
  if (!Number.isFinite(n)) return '—';
  return `$${n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// X.XX%, "—" on non-finite. Accepts an already-fractional number (0.15 ->
// "15.00%"). The caller does the division.
export function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(2)}%`;
}
