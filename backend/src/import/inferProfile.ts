import {
  profiles,
  normalizeHeaderMap,
  stripBom,
  type CsvProfile,
} from './csvProfiles';
import { mapCsvRow } from './mapRow';

/** Sentinel: pick profile from CSV headers and sample rows. */
export const AUTO_PROFILE_ID = 'auto';

const GENERIC_CANDIDATE_IDS = ['generic_simple', 'generic_amex'] as const;

// ── Bank-specific header signal functions ─────────────────────────────────────

function headerSet(headers: string[]): Set<string> {
  return new Set(headers.map((h) => stripBom(h).toLowerCase()));
}

function hasAll(hs: Set<string>, ...terms: string[]): boolean {
  return terms.every((t) => hs.has(t));
}

function hasAny(hs: Set<string>, ...terms: string[]): boolean {
  return terms.some((t) => hs.has(t));
}

function detectCanadianBank(headers: string[]): string | null {
  const hs = headerSet(headers);

  // RBC: unique "Description 1" / "Description 2" or "CAD$" column
  if (hasAny(hs, 'description 1', 'cad$')) return 'rbc';

  // BMO banking: typo "withdrawl" is a reliable fingerprint
  if (hs.has('withdrawl')) return 'bmo_banking';

  // BMO credit card: "item #" or "card #" alongside "transaction amount"
  if (hasAny(hs, 'item #', 'card #') && hs.has('transaction amount'))
    return 'bmo_credit_card';

  // Tangerine: Transaction + Name + Memo trio
  if (hasAll(hs, 'transaction', 'name', 'memo')) return 'tangerine';

  // Scotiabank banking: "withdrawals" + "deposits" (plural)
  if (hasAll(hs, 'withdrawals', 'deposits')) return 'scotiabank_banking';

  // National Bank: French "débit"/"crédit" headers (or both EN/FR present)
  if (hasAny(hs, 'débit', 'crédit')) return 'national_bank';

  // TD banking: "activity description" + split columns
  if (hs.has('activity description') && hasAny(hs, 'debit amount', 'credit amount'))
    return 'td_banking';

  // TD credit card: "transaction type" + "payee"
  if (hasAll(hs, 'transaction type', 'payee')) return 'td_credit_card';

  // Scotiabank credit card: "transaction details"
  if (hs.has('transaction details')) return 'scotiabank_credit_card';

  // CIBC: Debit + Credit with no Transaction Type (to avoid matching TD)
  if (
    hasAll(hs, 'debit', 'credit') &&
    !hs.has('transaction type') &&
    !hs.has('transaction amount')
  )
    return 'cibc';

  return null;
}

function amexHeaderSignals(headers: string[]): boolean {
  const hs = headerSet(headers);
  return (
    hs.has('charge amount') ||
    hs.has('appears on your statement as') ||
    hs.has('simplified details') ||
    hs.has('extended details')
  );
}

function scoreProfileHeaders(headers: string[], p: CsvProfile): number {
  const map = normalizeHeaderMap(headers);
  let s = 0;
  const cols = [p.dateHeaders, p.merchantHeaders];
  if (p.amountHeaders.length) cols.push(p.amountHeaders);
  for (const list of cols) {
    if (list.some((c) => map[c.toLowerCase()] !== undefined)) s += 1;
  }
  return s;
}

/**
 * Infer profile from headers + sample rows.
 * Checks Canadian bank signals first (deterministic), then falls back to
 * scoring generic profiles.
 */
export function inferProfileId(
  headers: string[],
  sampleRows: Record<string, string>[],
  defaultCurrency: string,
): string {
  // Canadian bank detection takes priority — header patterns are highly specific.
  const bank = detectCanadianBank(headers);
  if (bank) return bank;

  const maxSamples = Math.min(sampleRows.length, 20);
  const scores: Record<(typeof GENERIC_CANDIDATE_IDS)[number], number> = {
    generic_simple: 0,
    generic_amex: 0,
  };

  for (const id of GENERIC_CANDIDATE_IDS) {
    for (let i = 0; i < maxSamples; i++) {
      const m = mapCsvRow(sampleRows[i], headers, id, defaultCurrency);
      if (!('error' in m)) scores[id] += 1;
    }
  }

  let best: (typeof GENERIC_CANDIDATE_IDS)[number] = 'generic_simple';
  for (const id of GENERIC_CANDIDATE_IDS) {
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
