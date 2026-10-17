import { D, Decimal } from '../util/decimal';

export interface MonthlyActivity {
  /** 1-12. */
  month: number;
  /**
   * ANY transaction on the account in that month, draw or not.
   *
   * This is what defines coverage, and the distinction is load-bearing. Absence of
   * draws cannot tell an unimported month from a month with no draws taken: exclude
   * a genuine zero-draw month and the projection overstates; include an unimported
   * one and it understates exactly when data is missing. Presence of any transaction
   * separates them.
   */
  transactionCount: number;
  /** Net corp→personal draws in the month. Signed, so a reversal nets off. */
  draws: Decimal;
}

export interface RemainderProjection {
  year: number;
  /** Draws actually recorded in covered months. */
  actualToDate: Decimal;
  /** Covered months only — see `MonthlyActivity.transactionCount`. */
  coveredMonths: number;
  /** Elapsed months with no transactions at all, i.e. probably unimported. */
  uncoveredMonths: number[];
  monthlyRunRate: Decimal;
  /** Run rate x the months not yet covered, uncovered elapsed months included. */
  projectedRemainder: Decimal;
  projectedTotal: Decimal;
  /** The assumption, in words, for display beside the figure. */
  basis: string;
}

/**
 * Year-to-date actuals plus a run-rate projection of what is left.
 *
 * Deliberately not a scaled prior year. `projectPersonalFactsFromPrevYear` scales
 * year N and carries no year-N+1 transactions, which is the exact defect part 0
 * demotes — prod scenario 18 held zero 2026 rows while presenting as a 2026 number.
 *
 * An uncovered elapsed month is projected rather than treated as elapsed-and-empty:
 * if May's statement is missing, May's draws are unknown, not zero.
 */
export function projectRemainder(
  { months, asOfMonth, year }: { months: MonthlyActivity[]; asOfMonth: number; year: number },
): RemainderProjection {
  const byMonth = new Map(months.map((m) => [m.month, m]));
  const covered: MonthlyActivity[] = [];
  const uncoveredMonths: number[] = [];

  for (let m = 1; m <= asOfMonth; m += 1) {
    const entry = byMonth.get(m);
    // A month past `asOfMonth` is not uncovered, it simply has not happened.
    if (entry && entry.transactionCount > 0) covered.push(entry);
    else uncoveredMonths.push(m);
  }

  const actualToDate = covered.reduce((acc, m) => acc.plus(m.draws), D('0'));

  if (covered.length === 0) {
    return {
      year,
      actualToDate: D('0'),
      coveredMonths: 0,
      uncoveredMonths,
      monthlyRunRate: D('0'),
      projectedRemainder: D('0'),
      projectedTotal: D('0'),
      basis:
        `No months of ${year} have any transactions, so there is no run rate to project `
        + 'from. Import a statement first.',
    };
  }

  const monthlyRunRate = actualToDate.dividedBy(covered.length);
  // 12 less the months actually covered — so an unimported May is projected, not
  // silently counted as a zero-draw month that has already happened.
  const monthsToProject = 12 - covered.length;
  const projectedRemainder = monthlyRunRate.times(monthsToProject);

  return {
    year,
    actualToDate,
    coveredMonths: covered.length,
    uncoveredMonths,
    monthlyRunRate,
    projectedRemainder,
    projectedTotal: actualToDate.plus(projectedRemainder),
    basis: describeBasis(year, covered.length, monthlyRunRate, monthsToProject, uncoveredMonths),
  };
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function describeBasis(
  year: number,
  coveredMonths: number,
  runRate: Decimal,
  monthsToProject: number,
  uncoveredMonths: number[],
): string {
  const rate = Number(runRate.toFixed(2)).toLocaleString('en-CA', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  let basis =
    `Projected from ${coveredMonths} months of ${year} actuals, averaging $${rate} of draws `
    + `per month, applied to the remaining ${monthsToProject} months.`;
  if (uncoveredMonths.length > 0) {
    basis +=
      ` ${uncoveredMonths.map((m) => MONTH_NAMES[m - 1]).join(', ')} `
      + `${uncoveredMonths.length === 1 ? 'has' : 'have'} no transactions at all and `
      + `${uncoveredMonths.length === 1 ? 'was' : 'were'} projected rather than counted as `
      + 'zero — a missing statement is unknown, not empty.';
  }
  return basis;
}
