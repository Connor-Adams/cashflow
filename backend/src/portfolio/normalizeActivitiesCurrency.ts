/**
 * FX normalization for mixed-currency ACB streams.
 *
 * The pure ACB engine (`computeAcb`) is sync and assumes a single
 * currency — it emits a "Mixed currency detected" warning otherwise but
 * still does the math in whatever currency the first activity carries.
 *
 * Most positions are single-currency in practice, but a security can
 * trade in multiple currencies (e.g. a Canadian-listed ADR also bought
 * in USD in the same account). For those positions we must convert
 * every activity to a single base currency before walking ACB.
 *
 * This helper is async (because BoC FX lookups are HTTP-cached in the
 * DB) and is intended to run BEFORE `computeAcb`. The base currency is
 * taken from the FIRST activity in the sorted stream — matching the
 * existing engine convention — so single-currency streams round-trip
 * unchanged.
 *
 * For non-CAD base currencies, we chain via CAD:
 *     (X → base).rate = (X → CAD).rate / (base → CAD).rate
 * The Bank of Canada Valet API only exposes X→CAD series, so chaining
 * is the only option without a second FX provider.
 *
 * FX lookup failures are non-fatal — we emit a warning and pass the
 * activity through unconverted (matching the current no-crash
 * behaviour of the engine itself).
 */

import { ensureFxRate } from '../fx/bankOfCanada';
import type { AcbActivity } from './acb';

type FetchRate = (
  from: string,
  to: string,
  date: string
) => Promise<{ rate: number } | null>;

const round4 = (n: number) => Math.round(n * 10000) / 10000;

const defaultFetchRate: FetchRate = async (from, to, date) => {
  const result = await ensureFxRate(from, to, date);
  return result ? { rate: result.rate } : null;
};

/**
 * Convert every activity's `amount` and `fees` to the base currency
 * (the first activity's currency). Activities already in the base
 * currency are passed through unchanged.
 *
 * Returns the normalized list plus any per-activity FX-failure
 * warnings. On hard FX failure the original activity is passed through
 * verbatim (engine will then surface its own "Mixed currency" warning
 * downstream — the FX warning is added to clarify the cause).
 */
export async function normalizeActivitiesToCad(
  activities: AcbActivity[],
  fetchRate: FetchRate = defaultFetchRate
): Promise<{ normalized: AcbActivity[]; warnings: string[] }> {
  const warnings: string[] = [];
  if (activities.length === 0) {
    return { normalized: [], warnings };
  }

  // Use the same sort as computeAcb so the "first activity" picks the
  // same currency the engine would pick if no normalization happened.
  const sorted = [...activities].sort((a, b) => {
    if (a.tradeDate < b.tradeDate) return -1;
    if (a.tradeDate > b.tradeDate) return 1;
    return a.id - b.id;
  });

  const baseCurrency = sorted[0].currency;
  const normalized: AcbActivity[] = [];

  for (const activity of sorted) {
    if (!activity.currency || activity.currency === baseCurrency) {
      normalized.push(activity);
      continue;
    }

    const rate = await resolveRate(
      activity.currency,
      baseCurrency,
      activity.tradeDate,
      fetchRate
    );
    if (rate == null) {
      warnings.push(
        `FX lookup failed for ${activity.currency}->${baseCurrency} on ${activity.tradeDate} (activity ${activity.id}); passed through unconverted`
      );
      normalized.push(activity);
      continue;
    }

    normalized.push({
      ...activity,
      amount: activity.amount == null ? null : round4(activity.amount * rate),
      fees: activity.fees == null ? null : round4(activity.fees * rate),
      currency: baseCurrency,
    });
  }

  return { normalized, warnings };
}

/**
 * Resolve a from→to rate via Bank of Canada. Handles the common cases:
 *  - from === to: identity
 *  - to === 'CAD': direct lookup
 *  - from === 'CAD': inverse of (to → CAD)
 *  - otherwise: chain via CAD — (from → CAD) / (to → CAD)
 */
async function resolveRate(
  from: string,
  to: string,
  date: string,
  fetchRate: FetchRate
): Promise<number | null> {
  if (from === to) return 1;
  if (to === 'CAD') {
    const r = await fetchRate(from, to, date);
    return r ? r.rate : null;
  }
  if (from === 'CAD') {
    const r = await fetchRate(to, 'CAD', date);
    if (!r || r.rate === 0) return null;
    return 1 / r.rate;
  }
  // Chain X → CAD / base → CAD.
  const fromToCad = await fetchRate(from, 'CAD', date);
  const toToCad = await fetchRate(to, 'CAD', date);
  if (!fromToCad || !toToCad || toToCad.rate === 0) return null;
  return fromToCad.rate / toToCad.rate;
}
