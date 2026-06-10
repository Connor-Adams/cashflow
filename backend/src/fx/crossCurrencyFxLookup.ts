/**
 * Cross-currency FX lookup built on CAD-cross rates.
 *
 * The Bank of Canada Valet API (and therefore the FxRate table) only carries
 * X→CAD series, so a base lookup like `looseHistoricalFxLookup` can resolve
 * X→CAD but nothing else. Routes that accept an arbitrary reportingCurrency
 * (e.g. /api/fx/exposure?reportingCurrency=USD) need from→to for any pair —
 * without this, every non-reporting currency becomes an FX gap and totals
 * silently shrink.
 *
 * This wrapper derives the missing pairs the same way
 * `portfolio/normalizeActivitiesCurrency.ts` does:
 *   - from === to:   identity
 *   - to === 'CAD':  delegate to the base lookup
 *   - from === 'CAD': inverse — 1 / (to → CAD)
 *   - otherwise:     chain via CAD — (from → CAD) / (to → CAD)
 */

import type { FxLookup } from '../networth/unifyToCad';

export function withCadCrossRates(base: FxLookup): FxLookup {
  return async (from, to, asOf) => {
    if (from === to) return { rate: 1, ratedDate: asOf };
    if (to === 'CAD') return base(from, to, asOf);

    if (from === 'CAD') {
      const inverse = await base(to, 'CAD', asOf);
      if (!inverse || inverse.rate === 0) return null;
      return { rate: 1 / inverse.rate, ratedDate: inverse.ratedDate };
    }

    // Chain via CAD: (from → CAD) / (to → CAD).
    const fromToCad = await base(from, 'CAD', asOf);
    if (!fromToCad) return null;
    const toToCad = await base(to, 'CAD', asOf);
    if (!toToCad || toToCad.rate === 0) return null;
    // The chained rate is only as fresh as its stalest leg.
    const ratedDate =
      fromToCad.ratedDate < toToCad.ratedDate
        ? fromToCad.ratedDate
        : toToCad.ratedDate;
    return { rate: fromToCad.rate / toToCad.rate, ratedDate };
  };
}
