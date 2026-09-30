import type { RateTable } from './types';

/**
 * A rate table encoded from projection or recall was used for a period that has
 * already closed — i.e. for a return that is filed, or filing-due, against
 * numbers nobody checked against the published schedule.
 */
export class ProjectedRatesError extends Error {
  readonly year: number;
  /**
   * Read by the terminal error handler via `getErrorStatus`, so routes that do
   * not catch this explicitly still answer 409 with the message rather than a
   * bare 500. The scenario routes rely on exactly that — they have no local
   * rate-error branch, and the T1 tab reads its numbers from them.
   */
  // fallow-ignore-next-line unused-class-member
  readonly status = 409;
  constructor(year: number, periodEnd: string) {
    super(
      `ProjectedRatesError: the ${year} rate table is marked provenance: 'projected', `
      + `but the period ending ${periodEnd} has closed. Verify every constant in `
      + `backend/src/tax/data/rates-${year}.ts against the published CRA and provincial `
      + `schedules and set provenance: 'published'.`,
    );
    this.name = 'ProjectedRatesError';
    this.year = year;
  }
}

export interface RateUsageContext {
  /**
   * Last day the return covers, `YYYY-MM-DD`. The personal path passes
   * `${year}-12-31`; the corp path passes the fiscal year's end date, which is
   * why this is a period and not a year — a fiscal year ending 2026-06-30 is
   * closed in 2026 while the personal 2026 year is not.
   */
  periodEnd: string;
  now: Date;
}

/**
 * Refuse a projected table for a closed period.
 *
 * Enforced where the table is chosen rather than asserted in a test, because the
 * failure it guards is precisely one that passed every test: `rates-2026.ts`
 * disclosed its own projected status in a header comment and was served for
 * months regardless. A comment cannot be enforced; a field can.
 *
 * A projected table stays usable while the period is OPEN — that is what a
 * projection is for, and forward scenarios depend on it. Surfacing the weaker
 * confidence for an open year is the completeness report's job, not a refusal's.
 */
export function assertRatesUsable(rates: RateTable, { periodEnd, now }: RateUsageContext): void {
  if (rates.provenance !== 'projected') return;
  // A period ending today is not yet closed: filing cannot be due before the
  // period it covers has ended. ISO dates compare lexicographically.
  if (periodEnd >= toIsoDate(now)) return;
  throw new ProjectedRatesError(rates.year, periodEnd);
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
