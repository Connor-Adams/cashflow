import { FxRate } from '../models/FxRate';

interface BoCObservation {
  d: string;
  [series: string]: { v: string } | string;
}

interface BoCWindowResponse {
  observations?: BoCObservation[];
}

export type WindowFetcher = (
  startDate: string,
  endDate: string,
) => Promise<BoCWindowResponse | null>;

const SERIES = 'FXUSDCAD';

/**
 * Fetch a USD/CAD daily-rate window from the Bank of Canada Valet API.
 * Exported for use as the default fetcher; injectable via the `fetcher`
 * option for tests.
 */
export const defaultBoCWindowFetcher: WindowFetcher = async (startDate, endDate) => {
  const url = `https://www.bankofcanada.ca/valet/observations/${SERIES}/json?start_date=${startDate}&end_date=${endDate}`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[backfillUsdCadHistory] HTTP ${response.status} for ${url}`);
      return null;
    }
    return (await response.json()) as BoCWindowResponse;
  } catch (err) {
    console.error('[backfillUsdCadHistory] fetch error', err);
    return null;
  }
};

interface BackfillOptions {
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  fetcher?: WindowFetcher;
}

/**
 * Backfill historical USD→CAD rates from BoC for the given window.
 *
 * Idempotent: existing FxRate rows for the same (currency pair, rated_date)
 * are skipped. Returns the count of newly inserted rows.
 *
 * Non-fatal: a hard fetch failure logs and returns 0.
 */
export async function backfillUsdCadHistory(opts: BackfillOptions): Promise<number> {
  const fetcher = opts.fetcher ?? defaultBoCWindowFetcher;
  const data = await fetcher(opts.startDate, opts.endDate);
  if (!data?.observations) return 0;

  // Find which rated_dates we already have, so we skip them.
  const incomingDates = data.observations.map((o) => o.d);
  const existing = await FxRate.findAll({
    where: { fromCurrency: 'USD', toCurrency: 'CAD', ratedDate: incomingDates },
    attributes: ['ratedDate'],
  });
  const existingSet = new Set(existing.map((r) => r.ratedDate));

  const rowsToCreate: Array<{
    fromCurrency: string;
    toCurrency: string;
    ratedDate: string;
    rate: string;
    source: string;
    fetchedAt: Date;
  }> = [];

  for (const obs of data.observations) {
    if (existingSet.has(obs.d)) continue;
    const seriesValue = obs[SERIES];
    if (!seriesValue || typeof seriesValue !== 'object' || !('v' in seriesValue)) continue;
    const rate = Number(seriesValue.v);
    if (!Number.isFinite(rate)) continue;
    rowsToCreate.push({
      fromCurrency: 'USD',
      toCurrency: 'CAD',
      ratedDate: obs.d,
      rate: String(rate),
      source: 'bank_of_canada_backfill',
      fetchedAt: new Date(),
    });
  }

  if (rowsToCreate.length === 0) return 0;
  await FxRate.bulkCreate(rowsToCreate);
  console.log(
    `[backfillUsdCadHistory] inserted ${rowsToCreate.length} USD→CAD rows ` +
      `(${opts.startDate}..${opts.endDate})`,
  );
  return rowsToCreate.length;
}
