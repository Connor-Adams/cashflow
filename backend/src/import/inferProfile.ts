import {
  profiles,
  normalizeHeaderMap,
  stripBom,
  type CsvProfile,
} from './csvProfiles';
import { mapCsvRow } from './mapRow';

/** Sentinel: pick profile from CSV headers and sample rows. */
export const AUTO_PROFILE_ID = 'auto';

const CANDIDATE_IDS = ['generic_simple', 'generic_amex'] as const;

function amexHeaderSignals(headers: string[]): boolean {
  const joined = headers
    .map((h) => stripBom(h).toLowerCase())
    .join('\0');
  return (
    joined.includes('charge amount') ||
    joined.includes('appears on your statement') ||
    joined.includes('simplified detail') ||
    joined.includes('extended detail')
  );
}

function scoreProfileHeaders(headers: string[], p: CsvProfile): number {
  const map = normalizeHeaderMap(headers);
  let s = 0;
  for (const list of [p.dateHeaders, p.merchantHeaders, p.amountHeaders]) {
    if (list.some((c) => map[c.toLowerCase()] !== undefined)) s += 1;
  }
  return s;
}

/**
 * Pick generic_simple vs generic_amex from raw issuer CSV: try mapping sample
 * rows, then fall back to header overlap.
 */
export function inferProfileId(
  headers: string[],
  sampleRows: Record<string, string>[],
  defaultCurrency: string,
): string {
  const maxSamples = Math.min(sampleRows.length, 20);
  const scores: Record<(typeof CANDIDATE_IDS)[number], number> = {
    generic_simple: 0,
    generic_amex: 0,
  };

  for (const id of CANDIDATE_IDS) {
    for (let i = 0; i < maxSamples; i++) {
      const m = mapCsvRow(sampleRows[i], headers, id, defaultCurrency);
      if (!('error' in m)) scores[id] += 1;
    }
  }

  let best: (typeof CANDIDATE_IDS)[number] = 'generic_simple';
  for (const id of CANDIDATE_IDS) {
    if (scores[id] > scores[best]) best = id;
  }

  const maxScore = Math.max(scores.generic_simple, scores.generic_amex);
  if (maxScore > 0) {
    if (
      scores.generic_simple === scores.generic_amex &&
      scores.generic_amex > 0 &&
      amexHeaderSignals(headers)
    ) {
      return 'generic_amex';
    }
    return best;
  }

  const hs = scoreProfileHeaders(headers, profiles.generic_simple);
  const ha = scoreProfileHeaders(headers, profiles.generic_amex);
  if (ha > hs) return 'generic_amex';
  if (hs > ha) return 'generic_simple';
  return amexHeaderSignals(headers) ? 'generic_amex' : 'generic_simple';
}

/** Resolve requested profile id; `auto` / empty uses inference after CSV parse. */
export function resolveProfileIdForImport(
  requested: string | null | undefined,
  envProfileId: string | undefined,
  headers: string[],
  sampleRows: Record<string, string>[],
  defaultCurrency: string,
): { profileId: string; inferred: boolean } {
  const env = envProfileId?.trim();
  if (env && env !== AUTO_PROFILE_ID) {
    return { profileId: env, inferred: false };
  }
  const req = requested?.trim() ?? '';
  if (req && req !== AUTO_PROFILE_ID) {
    return { profileId: req, inferred: false };
  }
  return {
    profileId: inferProfileId(headers, sampleRows, defaultCurrency),
    inferred: true,
  };
}
