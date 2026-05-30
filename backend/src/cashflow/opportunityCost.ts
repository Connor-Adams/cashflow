/**
 * Opportunity-cost future-value math (issue #252).
 *
 * Answers "what if I invested this instead of spending it?" — a cross-cutting
 * widget, not a scenario type (see issue #252 discussion vs. #213).
 *
 * Two modes:
 *
 *   one-time   future value of a single lump sum:
 *                FV = amount * (1 + r)^t
 *
 *   recurring  future value of a level contribution made every period, with
 *              the contribution invested at the END of each period (ordinary
 *              annuity):
 *                FV = C * ((1 + i)^n - 1) / i
 *              where i = r / periodsPerYear and n = periodsPerYear * t.
 *
 * Everything here is pure (no DB, no I/O) so the math can be unit-tested in
 * isolation and reused by the route, which performs NO persistence — calculating
 * an opportunity cost never touches transaction totals (AC).
 */

export type OpportunityCostMode = 'one-time' | 'recurring';

export type OpportunityCostCadence =
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'quarterly'
  | 'annual';

/** How many contribution periods each cadence has per year. */
export const CADENCE_PERIODS_PER_YEAR: Record<OpportunityCostCadence, number> = {
  weekly: 52,
  biweekly: 26,
  monthly: 12,
  quarterly: 4,
  annual: 1,
};

export const OPPORTUNITY_COST_MODES: readonly OpportunityCostMode[] = [
  'one-time',
  'recurring',
];

export const OPPORTUNITY_COST_CADENCES = Object.keys(
  CADENCE_PERIODS_PER_YEAR
) as OpportunityCostCadence[];

/** Guard-rails so a typo can't produce a nonsense projection. */
export const MAX_HORIZON_YEARS = 100;
export const MAX_ANNUAL_RETURN_RATE = 1; // 100% — anything higher is a typo
export const MIN_ANNUAL_RETURN_RATE = 0;
export const MAX_AMOUNT = 1_000_000_000;

export type OpportunityCostInput = {
  mode: OpportunityCostMode;
  /** The money being spent. For recurring, this is the per-period amount. */
  amount: number;
  /** Required for recurring; ignored for one-time (defaults to monthly). */
  cadence?: OpportunityCostCadence;
  /** Investment horizon in years (may be fractional). */
  horizonYears: number;
  /** Assumed annual return rate as a decimal (0.07 == 7%). */
  annualReturnRate: number;
};

export type OpportunityCostResult = {
  mode: OpportunityCostMode;
  amount: number;
  cadence: OpportunityCostCadence;
  horizonYears: number;
  annualReturnRate: number;
  /** Total money put in: lump sum (one-time) or contributions summed (recurring). */
  totalContributions: number;
  /** Projected value at the end of the horizon. */
  futureValue: number;
  /** futureValue - totalContributions: the growth you'd forgo by spending. */
  gain: number;
  /**
   * For recurring, contributions expressed as a per-month figure (so weekly /
   * quarterly cadences are comparable). For one-time this is the lump sum.
   */
  monthlyEquivalent: number;
  /** Human-readable assumptions, ready to render in the results panel. */
  assumptions: string[];
};

/** Round to cents to keep serialized output tidy; math stays full-precision until here. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function formatPercent(rate: number): string {
  const pct = rate * 100;
  // Trim trailing zeros: 7 -> "7%", 7.5 -> "7.5%".
  const str = Number.isInteger(pct) ? String(pct) : String(round2(pct));
  return `${str}%`;
}

function formatYears(years: number): string {
  const label = years === 1 ? 'year' : 'years';
  return `${years} ${label}`;
}

const CADENCE_LABELS: Record<OpportunityCostCadence, string> = {
  weekly: 'weekly',
  biweekly: 'every two weeks',
  monthly: 'monthly',
  quarterly: 'quarterly',
  annual: 'annually',
};

/**
 * Compute the opportunity cost of spending `amount` instead of investing it.
 *
 * Assumes a valid input (run {@link validateOpportunityCostInput} first at the
 * boundary). Pure and deterministic.
 */
export function computeOpportunityCost(
  input: OpportunityCostInput
): OpportunityCostResult {
  const { mode, amount, horizonYears, annualReturnRate } = input;
  const cadence: OpportunityCostCadence = input.cadence ?? 'monthly';
  const r = annualReturnRate;

  let totalContributions: number;
  let futureValue: number;
  let monthlyEquivalent: number;
  const assumptions: string[] = [];

  if (mode === 'one-time') {
    totalContributions = amount;
    futureValue = amount * Math.pow(1 + r, horizonYears);
    monthlyEquivalent = amount;
    assumptions.push(
      `A one-time amount invested today at ${formatPercent(
        r
      )} annual return, compounded over ${formatYears(horizonYears)}.`
    );
  } else {
    const periodsPerYear = CADENCE_PERIODS_PER_YEAR[cadence];
    const n = periodsPerYear * horizonYears;
    const i = r / periodsPerYear;
    totalContributions = amount * n;
    // Ordinary annuity; the closed form divides by i, so handle the zero-rate
    // limit explicitly (with no growth, FV is just the sum of contributions).
    futureValue =
      i === 0 ? amount * n : amount * ((Math.pow(1 + i, n) - 1) / i);
    monthlyEquivalent = (amount * periodsPerYear) / 12;
    assumptions.push(
      `A ${CADENCE_LABELS[cadence]} contribution invested at ${formatPercent(
        r
      )} annual return, compounded over ${formatYears(horizonYears)}.`
    );
    assumptions.push(
      'Each contribution is invested at the end of its period (ordinary annuity).'
    );
  }

  const gain = futureValue - totalContributions;

  return {
    mode,
    amount,
    cadence,
    horizonYears,
    annualReturnRate,
    totalContributions: round2(totalContributions),
    futureValue: round2(futureValue),
    gain: round2(gain),
    monthlyEquivalent: round2(monthlyEquivalent),
    assumptions,
  };
}

export type ValidationOk = { ok: true; value: OpportunityCostInput };
export type ValidationErr = { ok: false; error: string };
export type ValidationResult = ValidationOk | ValidationErr;

function toFiniteNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Validate and coerce an untrusted payload (e.g. a request body) into a typed
 * {@link OpportunityCostInput}. Accepts string-numeric fields and coerces them.
 */
export function validateOpportunityCostInput(raw: unknown): ValidationResult {
  if (raw == null || typeof raw !== 'object') {
    return { ok: false, error: 'Request body must be an object.' };
  }
  const body = raw as Record<string, unknown>;

  const mode = body.mode;
  if (mode !== 'one-time' && mode !== 'recurring') {
    return {
      ok: false,
      error: `mode must be one of: ${OPPORTUNITY_COST_MODES.join(', ')}.`,
    };
  }

  const amount = toFiniteNumber(body.amount);
  if (amount === null || amount <= 0) {
    return { ok: false, error: 'amount must be a positive number.' };
  }
  if (amount > MAX_AMOUNT) {
    return { ok: false, error: `amount must be at most ${MAX_AMOUNT}.` };
  }

  const horizonYears = toFiniteNumber(body.horizonYears);
  if (horizonYears === null || horizonYears <= 0) {
    return { ok: false, error: 'horizonYears must be a positive number.' };
  }
  if (horizonYears > MAX_HORIZON_YEARS) {
    return {
      ok: false,
      error: `horizonYears must be at most ${MAX_HORIZON_YEARS}.`,
    };
  }

  const annualReturnRate = toFiniteNumber(body.annualReturnRate);
  if (annualReturnRate === null) {
    return { ok: false, error: 'annualReturnRate must be a number.' };
  }
  if (
    annualReturnRate < MIN_ANNUAL_RETURN_RATE ||
    annualReturnRate > MAX_ANNUAL_RETURN_RATE
  ) {
    return {
      ok: false,
      error: `annualReturnRate must be between ${MIN_ANNUAL_RETURN_RATE} and ${MAX_ANNUAL_RETURN_RATE} (as a decimal, e.g. 0.07 for 7%).`,
    };
  }

  let cadence: OpportunityCostCadence = 'monthly';
  if (mode === 'recurring') {
    const rawCadence = body.cadence;
    if (
      typeof rawCadence !== 'string' ||
      !(rawCadence in CADENCE_PERIODS_PER_YEAR)
    ) {
      return {
        ok: false,
        error: `cadence must be one of: ${OPPORTUNITY_COST_CADENCES.join(
          ', '
        )}.`,
      };
    }
    cadence = rawCadence as OpportunityCostCadence;
  } else if (typeof body.cadence === 'string') {
    // one-time ignores cadence but tolerate a valid one being sent.
    if (body.cadence in CADENCE_PERIODS_PER_YEAR) {
      cadence = body.cadence as OpportunityCostCadence;
    }
  }

  return {
    ok: true,
    value: { mode, amount, cadence, horizonYears, annualReturnRate },
  };
}
