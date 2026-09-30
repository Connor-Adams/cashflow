import { D, Decimal } from '../util/decimal';

export type Instalment = { dueOn: string; amount: Decimal };

/** The CRA due dates. Correct as they stand; asserted so a rewrite cannot drift. */
const DUE_DATES = ['03-15', '06-15', '09-15', '12-15'];

/**
 * CRA requires instalments only when net tax owing exceeds this. "More than
 * $3,000", so exactly $3,000 requires nothing.
 */
export const INSTALMENT_THRESHOLD = D('3000');

/**
 * Split an amount across the four CRA dates.
 *
 * Divide-by-four is exactly the prior-year option and exactly the current-year
 * option — two of CRA's three choices — so the arithmetic here was already right.
 * What was missing was any statement of WHICH year's owing it takes, and any test of
 * whether instalments are required at all.
 */
export function quarterlyInstalments(
  annualOwing: Decimal,
  year: number = new Date().getUTCFullYear(),
): Instalment[] {
  const per = annualOwing.dividedBy(4);
  return DUE_DATES.map((md) => ({ dueOn: `${year}-${md}`, amount: per }));
}

/**
 * CRA's no-calculation option — the amounts on the instalment reminder.
 *
 * A quarter of the SECOND prior year in March and June, then the prior year's
 * remainder split over September and December. Floored at zero: when the second
 * prior year was the larger, the first two payments can already exceed the prior
 * year's total, and CRA's reminder never asks for money back.
 */
export function noCalculationInstalments(
  priorYearOwing: Decimal,
  twoYearsPriorOwing: Decimal,
  year: number,
): Instalment[] {
  const firstHalf = twoYearsPriorOwing.dividedBy(4);
  const remainder = Decimal.max(priorYearOwing.minus(firstHalf.times(2)), D('0'));
  const secondHalf = remainder.dividedBy(2);
  return [
    { dueOn: `${year}-${DUE_DATES[0]}`, amount: firstHalf },
    { dueOn: `${year}-${DUE_DATES[1]}`, amount: firstHalf },
    { dueOn: `${year}-${DUE_DATES[2]}`, amount: secondHalf },
    { dueOn: `${year}-${DUE_DATES[3]}`, amount: secondHalf },
  ];
}

/** Which of CRA's three calculations an option follows. */
export type InstalmentBasis = 'no_calculation' | 'prior_year' | 'current_year';

export interface InstalmentOption {
  basis: InstalmentBasis;
  instalments: Instalment[];
  total: Decimal;
  /**
   * True only for the current-year estimate: it is the one option that can leave a
   * shortfall, and CRA charges interest on the difference. Surfaced rather than
   * decided, because choosing for the taxpayer hides the trade-off.
   */
  carriesInterestRisk: boolean;
}

export interface NetOwingWindow {
  /** The year instalments would be paid in. */
  currentYear: Decimal;
  priorYear: Decimal;
  twoYearsPrior: Decimal;
}

export interface InstalmentObligation {
  year: number;
  required: boolean;
  /** Plain-language statement of which conjunct decided it. */
  reason: string;
  /** The recommended option's instalments, or empty when none are required. */
  instalments: Instalment[];
  options: InstalmentOption[];
  recommended: InstalmentBasis;
  /**
   * When the year's remaining balance is due — April 30 of the following year.
   *
   * Reported even when no instalments are required, because it is the larger
   * obligation: for 2026 the March instalment is nothing and the April balance is
   * $8,400-$16,610. Nothing in the app named this date.
   */
  balanceDueOn: string;
}

/**
 * Whether instalments are required, and what the three CRA options come to.
 *
 * The test has two conjuncts: net tax owing must exceed the threshold in the current
 * year **and** in either of the two preceding years. The second is the one that
 * matters here — Connor's 2026 owing is well over $3,000 while 2024 was $0.00 and
 * 2025 was a $47.35 refund, so 2026 required nothing. A single-conjunct rule would
 * have reported him late all year, with interest supposedly accruing.
 */
export function instalmentObligation(
  { year, netOwing }: { year: number; netOwing: NetOwingWindow },
): InstalmentObligation {
  const balanceDueOn = `${year + 1}-04-30`;
  const overThisYear = netOwing.currentYear.greaterThan(INSTALMENT_THRESHOLD);
  const overAPriorYear = netOwing.priorYear.greaterThan(INSTALMENT_THRESHOLD)
    || netOwing.twoYearsPrior.greaterThan(INSTALMENT_THRESHOLD);

  const options: InstalmentOption[] = [
    {
      basis: 'no_calculation',
      instalments: noCalculationInstalments(netOwing.priorYear, netOwing.twoYearsPrior, year),
      total: netOwing.priorYear,
      carriesInterestRisk: false,
    },
    {
      basis: 'prior_year',
      instalments: quarterlyInstalments(netOwing.priorYear, year),
      total: netOwing.priorYear,
      carriesInterestRisk: false,
    },
    {
      basis: 'current_year',
      instalments: quarterlyInstalments(netOwing.currentYear, year),
      total: netOwing.currentYear,
      carriesInterestRisk: true,
    },
  ];

  // Prior-year is the safe default for a rising-income year: pay what last year
  // proved, settle the rest in April with no interest.
  const recommended: InstalmentBasis = 'prior_year';

  if (!overThisYear) {
    return {
      year,
      required: false,
      reason:
        `Net tax owing for ${year} is ${netOwing.currentYear.toFixed(2)}, not more than `
        + `${INSTALMENT_THRESHOLD.toFixed(2)} — no instalments are required for the current year.`,
      instalments: [],
      options,
      recommended,
      balanceDueOn,
    };
  }
  if (!overAPriorYear) {
    return {
      year,
      required: false,
      reason:
        `Net tax owing for ${year} exceeds ${INSTALMENT_THRESHOLD.toFixed(2)}, but neither `
        + `${year - 1} (${netOwing.priorYear.toFixed(2)}) nor ${year - 2} `
        + `(${netOwing.twoYearsPrior.toFixed(2)}) did. CRA requires both, so no instalments `
        + `are owed for ${year} — the whole amount is due with the return.`,
      instalments: [],
      options,
      recommended,
      balanceDueOn,
    };
  }

  return {
    year,
    required: true,
    reason:
      `Net tax owing exceeds ${INSTALMENT_THRESHOLD.toFixed(2)} for ${year} and for at least `
      + `one of ${year - 1} and ${year - 2}, so quarterly instalments are required.`,
    instalments: options.find((o) => o.basis === recommended)!.instalments,
    options,
    recommended,
    balanceDueOn,
  };
}
