import { D } from '../util/decimal';
import { buildPersonalFacts } from '../builders/buildPersonalFacts';
import { buildT1 } from '../engine/t1';
import { RateTableMissingError, ratesFor } from '../engine/brackets';
import { instalmentObligation, type InstalmentObligation } from '../engine/instalments';
import { buildForwardView, type ForwardView } from './buildForwardView';

export interface Outlook {
  year: number;
  obligation: InstalmentObligation;
  forward: ForwardView;
  /**
   * Net tax owing per year across the three-year window, keyed by year. The current
   * year is its YEAR-TO-DATE figure; `projectedCurrentYearNetOwing` is what the
   * threshold test actually used.
   */
  netOwingByYear: Record<number, string>;
  /**
   * The current year's net owing projected to a full year, which is what the CRA
   * threshold test is defined on.
   *
   * Using the year-to-date figure instead would understate it for most of the year and
   * report "no instalments required" to a taxpayer who will plainly owe — in testing,
   * two months of a $168,000 annual draw pattern came to under the $3,000 threshold.
   * CRA's test asks about the year's owing, and for an unfinished year that can only
   * be an estimate.
   */
  projectedCurrentYearNetOwing: string;
  /**
   * Years in the window whose rate table is a projection rather than published
   * figures.
   *
   * Named rather than suppressed: the threshold verdict is only as good as the
   * constants behind it, and `rates-2024.ts` says outright it was encoded from recall
   * and never cross-checked — while 2024 is one of the two years that decided Connor
   * owed no 2026 instalments.
   */
  provenanceWarnings: string[];
}

/**
 * What is coming: whether instalments are required, what the three options come to,
 * when the balance is due, and the current year at its run rate.
 *
 * The three-year window is recomputed from facts rather than read from stored
 * snapshots so all three share a basis, and because `netTaxOwing` is newer than the
 * snapshots in prod.
 *
 * Part 2's closed-year refusal is deliberately NOT applied. That guard exists to stop
 * a projected table being served as a filed return; here a historical figure is read
 * to evaluate a threshold. Applying it would make the whole outlook fail with 409
 * because one historical table is unverified, hiding the warning that matters.
 */
export async function buildOutlook(
  { entityId, year, now = new Date() }: { entityId: number; year: number; now?: Date },
): Promise<Outlook> {
  const years = [year, year - 1, year - 2];
  const netOwingByYear: Record<number, string> = {};
  const provenanceWarnings: string[] = [];
  let currentFacts = null as Awaited<ReturnType<typeof buildPersonalFacts>> | null;

  for (const y of years) {
    let rates;
    try {
      rates = ratesFor(y);
    } catch (err) {
      if (err instanceof RateTableMissingError) {
        // A year with no encoded table contributes nothing to the threshold test
        // rather than failing the whole outlook. Treated as zero and said so.
        netOwingByYear[y] = '0.00';
        provenanceWarnings.push(
          `No rate table is encoded for ${y}, so its net tax owing is treated as $0.00 in the `
          + 'instalment threshold test.',
        );
        continue;
      }
      throw err;
    }
    const facts = await buildPersonalFacts(entityId, y);
    if (y === year) currentFacts = facts;
    netOwingByYear[y] = buildT1(facts, rates).totals.netTaxOwing.toFixed(2);
    if (rates.provenance === 'projected') {
      provenanceWarnings.push(
        `The ${y} rate table is a projection, not published figures, so the `
        + `${netOwingByYear[y]} net tax owing it produces — one of the inputs to the `
        + 'instalment threshold test — carries that uncertainty.',
      );
    }
  }

  const facts = currentFacts ?? await buildPersonalFacts(entityId, year);
  const forward = await buildForwardView({
    entityId, year, facts, rates: ratesFor(year), now,
  });

  // The threshold test reads the FULL year's owing, so the current year's YTD figure
  // is grossed up by the projected remainder's tax. The prior two years are complete
  // and need no such adjustment.
  const projectedCurrentYearNetOwing = D(netOwingByYear[year])
    .plus(D(forward.projectedAdditionalTax))
    .toFixed(2);

  const obligation = instalmentObligation({
    year,
    netOwing: {
      currentYear: D(projectedCurrentYearNetOwing),
      priorYear: D(netOwingByYear[year - 1]),
      twoYearsPrior: D(netOwingByYear[year - 2]),
    },
  });

  return {
    year,
    obligation,
    forward,
    netOwingByYear,
    projectedCurrentYearNetOwing,
    provenanceWarnings,
  };
}
