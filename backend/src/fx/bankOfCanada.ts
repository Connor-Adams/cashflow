/**
 * Bank of Canada (BoC) FX rate fetcher.
 *
 * Uses the free BoC Valet API:
 *   https://www.bankofcanada.ca/valet/observations/{SERIES}/json?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 *
 * Series naming convention: FXUSDCAD, FXEURCAD, etc.
 * The BoC publishes once per business day. Weekend/holiday dates return the
 * prior business day's rate (or return no observations for that specific date).
 * We query a 10-day rolling window ending at asOfDate and take the latest
 * observation — this ensures we always get a rate even around long weekends.
 */

import { Op } from 'sequelize';
import { FxRate } from '../models/FxRate';

/** Days back from asOfDate that ensureFxRate considers a cached row "fresh enough". */
export const ENSURE_FX_CACHE_WINDOW_DAYS = 7;

/**
 * Compute the start date for the BoC observation window.
 * We look back 10 calendar days to ensure we always capture a published rate
 * even across long weekends and statutory holidays.
 */
function windowStart(asOfDate: string): string {
  const d = new Date(`${asOfDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 10);
  return d.toISOString().slice(0, 10);
}

/** Subtract `days` calendar days from a YYYY-MM-DD date string. */
function subtractDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

interface BoCObservation {
  d: string;
  [series: string]: { v: string } | string;
}

interface BoCResponse {
  observations?: BoCObservation[];
}

/**
 * Fetch the most-recent BoC rate for `from`→`to` at or before `asOfDate`.
 *
 * Strategy: query a 10-day window ending at `asOfDate` and take the last
 * observation. The BoC API returns observations in ascending date order.
 *
 * Returns `null` on hard failure (HTTP error, empty window, parse failure).
 * CAD→CAD short-circuits to `{ rate: 1, ratedDate: asOfDate }` immediately.
 */
export async function fetchBoCRate(
  from: string,
  to: string,
  asOfDate: string
): Promise<{ rate: number; ratedDate: string } | null> {
  if (from === to) return { rate: 1, ratedDate: asOfDate };

  // BoC only has CAD-cross rates. If `to` is not CAD we'd need to chain,
  // but for now this module only supports X→CAD.
  if (to !== 'CAD') {
    console.error(`[bankOfCanada] Only X→CAD is supported, got ${from}→${to}`);
    return null;
  }

  const series = `FX${from.toUpperCase()}CAD`;
  const start = windowStart(asOfDate);
  const url = `https://www.bankofcanada.ca/valet/observations/${series}/json?start_date=${start}&end_date=${asOfDate}`;

  let data: BoCResponse;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[bankOfCanada] HTTP ${response.status} for ${url}`);
      return null;
    }
    data = (await response.json()) as BoCResponse;
  } catch (err) {
    console.error('[bankOfCanada] fetch error', err);
    return null;
  }

  const observations = data.observations;
  if (!observations || observations.length === 0) {
    console.error(`[bankOfCanada] No observations for ${series} in window ${start}..${asOfDate}`);
    return null;
  }

  // Observations arrive in ascending date order; take the last one.
  const last = observations[observations.length - 1];
  const seriesValue = last[series];
  if (!seriesValue || typeof seriesValue !== 'object' || !('v' in seriesValue)) {
    console.error('[bankOfCanada] Unexpected observation shape', last);
    return null;
  }

  const rate = Number(seriesValue.v);
  if (!Number.isFinite(rate)) {
    console.error('[bankOfCanada] Non-numeric rate value', seriesValue.v);
    return null;
  }

  return { rate, ratedDate: last.d };
}

/**
 * Return a cached FxRate from the DB if one exists with ratedDate within the
 * last 7 days; otherwise fetch from BoC, persist the row, and return it.
 *
 * CAD→CAD still short-circuits (no DB hit, no HTTP call).
 *
 * Returns `null` only on hard failure.
 */
export async function ensureFxRate(
  from: string,
  to: string,
  asOfDate: string
): Promise<{ rate: number; ratedDate: string } | null> {
  if (from === to) return { rate: 1, ratedDate: asOfDate };

  // Check DB for a recent cached row.
  const sevenDaysAgo = subtractDays(asOfDate, ENSURE_FX_CACHE_WINDOW_DAYS);
  const cached = await FxRate.findOne({
    where: {
      fromCurrency: from,
      toCurrency: to,
      ratedDate: { [Op.gte]: sevenDaysAgo },
    },
    order: [['ratedDate', 'DESC']],
  });

  if (cached) {
    return { rate: Number(cached.rate), ratedDate: cached.ratedDate };
  }

  // Cache miss — fetch from BoC and persist.
  const result = await fetchBoCRate(from, to, asOfDate);
  if (!result) return null;

  try {
    await FxRate.create({
      fromCurrency: from,
      toCurrency: to,
      ratedDate: result.ratedDate,
      rate: String(result.rate),
      source: 'bank_of_canada',
      fetchedAt: new Date(),
    });
  } catch (err) {
    // Persist failure is non-fatal — we already have the rate in memory.
    console.warn('[bankOfCanada] Failed to cache FxRate row', err);
  }

  return result;
}
