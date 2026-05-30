/**
 * Counterparty promotion suggestion detector (#373).
 *
 * Groups un-linked transactions by (householdId, normalized(counterparty_raw))
 * in the trailing 90 days. When the support count >= threshold (from
 * CashflowSettings.counterpartyPromotionThreshold, default 3), surfaces a
 * suggestion to bulk-promote into a Contact.
 *
 * "Un-linked" means `counterparty_contact_id IS NULL`. Once a Contact is
 * linked, the txn drops out of the candidate pool automatically (AC #4).
 *
 * Persisted dismissals live in `ai_suggestions` rows with
 * `kind='counterparty_promotion'` and `status='rejected'`, keyed by the
 * normalized name in `input_snapshot.normalizedName`. The detector filters
 * out any normalized name that has a rejected row, so "ignore forever"
 * sticks across detector runs (AC #3).
 */
import { QueryTypes } from 'sequelize';
import { sequelize } from '../models';
import { CashflowSettings } from '../models/CashflowSettings';
import { CASHFLOW_SETTINGS_DEFAULTS } from '../models/CashflowSettings';
import { jsonExtractText } from '../util/dialectSql';

/**
 * Day-window the detector looks back. Issue #373 fixes this at 90 days;
 * exported as a const so the threshold can be tweaked without scattering
 * the literal across queries + tests.
 */
export const COUNTERPARTY_PROMOTION_WINDOW_DAYS = 90;

/**
 * Maximum number of promotion suggestions returned per detector call. The
 * inbox UI surfaces them as cards so an absurd cap (e.g. 5000) would
 * destroy the page; cap matches `findRuleProposals` for consistency.
 */
export const COUNTERPARTY_PROMOTION_LIMIT = 20;

export type CounterpartyPromotion = {
  /** Lowercase, whitespace-collapsed key. Stable across requests. */
  normalizedName: string;
  /** Sample raw value (most common original casing). Used for UI + Contact name. */
  sampleRaw: string;
  /** Count of un-linked txns in the trailing 90 days. */
  supportCount: number;
  /** First-9 example transaction ids — used by the bulk-link endpoint. */
  exampleTransactionIds: number[];
};

/**
 * Exact-match normalization per issue #373: lowercase, collapse whitespace.
 * Fuzzy matching across casing/punctuation variants is explicitly out of
 * scope ("v2 — start with exact normalized match").
 */
export function normalizeCounterpartyName(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
  return trimmed === '' ? null : trimmed;
}

type CandidateRow = {
  id: number;
  counterpartyRaw: string | null;
  counterpartyraw?: string | null;
};

/**
 * Read the household's promotion threshold. Per-user settings table —
 * picks the first row found for any member of the household. Falls back
 * to the defaults bundle when no member has saved a row yet.
 */
export async function resolveCounterpartyPromotionThreshold(
  householdId: number,
): Promise<number> {
  const row = await sequelize.query<{ value: number }>(
    `SELECT cs.counterparty_promotion_threshold AS value
       FROM cashflow_settings cs
       JOIN household_members hm ON hm.user_id = cs.user_id
      WHERE hm.household_id = ?
      ORDER BY cs.id ASC
      LIMIT 1`,
    { replacements: [householdId], type: QueryTypes.SELECT },
  );
  if (row.length === 0) return CASHFLOW_SETTINGS_DEFAULTS.counterpartyPromotionThreshold;
  const value = Number(row[0]?.value ?? 0);
  return Number.isInteger(value) && value >= 2
    ? value
    : CASHFLOW_SETTINGS_DEFAULTS.counterpartyPromotionThreshold;
}

/**
 * Threshold lookup with a superadmin-friendly null fallback. Superadmin
 * (no household scope) gets the default threshold because per-user
 * threshold doesn't apply at the global scope.
 */
export async function resolveThresholdForScope(
  householdId: number | null,
): Promise<number> {
  if (householdId == null) {
    return CASHFLOW_SETTINGS_DEFAULTS.counterpartyPromotionThreshold;
  }
  return resolveCounterpartyPromotionThreshold(householdId);
}

function asOfDate(now: Date = new Date()): string {
  const cutoff = new Date(now.getTime() - COUNTERPARTY_PROMOTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return cutoff.toISOString().slice(0, 10);
}

/**
 * Find counterparty promotion suggestions for a household.
 *
 * Returns groups where:
 *   - txn.householdId matches (or any household when householdId === null,
 *     for superadmin)
 *   - txn.counterpartyContactId IS NULL
 *   - txn.counterpartyRaw IS NOT NULL AND trimmed != ''
 *   - txn.date >= today - 90 days
 *   - grouped in JS by normalizeCounterpartyName(counterpartyRaw)
 *   - count >= threshold
 *   - normalized name is NOT in the household's dismissal list
 *
 * Grouping happens in JS rather than SQL because SQL `LOWER(TRIM(...))`
 * does not collapse INTERNAL whitespace (`'  jane  doe '` -> `'jane  doe'`,
 * a different key from `'jane doe'`). The candidate set is bounded by
 * the un-linked, in-window filter, so pulling rows + grouping in-memory
 * is comparable in cost to GROUP BY for any realistic household.
 *
 * Results are sorted by supportCount DESC then normalizedName ASC for
 * deterministic ordering.
 */
export async function findCounterpartyPromotions(
  householdId: number | null,
  options: { now?: Date; threshold?: number } = {},
): Promise<CounterpartyPromotion[]> {
  const threshold = options.threshold ?? (await resolveThresholdForScope(householdId));
  const cutoff = asOfDate(options.now);

  const rows = await sequelize.query<CandidateRow>(
    `SELECT id, counterparty_raw AS "counterpartyRaw"
       FROM transactions
      WHERE (? IS NULL OR household_id = ?)
        AND counterparty_contact_id IS NULL
        AND counterparty_raw IS NOT NULL
        AND TRIM(counterparty_raw) != ''
        AND date >= ?`,
    {
      replacements: [householdId, householdId, cutoff],
      type: QueryTypes.SELECT,
    },
  );

  if (rows.length === 0) return [];

  // Pull dismissals in one shot. Same household-scope rule as the main
  // query so cross-household dismissals can't suppress someone else's
  // suggestions.
  const dismissed = await sequelize.query<{ name: string }>(
    `SELECT ${jsonExtractText('input_snapshot', 'normalizedName')} AS name
       FROM ai_suggestions
      WHERE kind = 'counterparty_promotion'
        AND status = 'rejected'
        AND (? IS NULL OR household_id = ?)`,
    {
      replacements: [householdId, householdId],
      type: QueryTypes.SELECT,
    },
  );
  const rejected = new Set(
    dismissed
      .map((r) => (r.name ?? '').toLowerCase())
      .filter((p) => p.length > 0),
  );

  // Group in JS using the canonical normalizer. Track ids + a sample raw
  // value (first encountered) so the inbox card can display real casing.
  type Bucket = {
    normalizedName: string;
    sampleRaw: string;
    ids: number[];
  };
  const buckets = new Map<string, Bucket>();
  for (const row of rows) {
    const raw = row.counterpartyRaw ?? row.counterpartyraw ?? null;
    const normalized = normalizeCounterpartyName(raw);
    if (!normalized) continue;
    if (rejected.has(normalized)) continue;
    const id = Number(row.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    const bucket = buckets.get(normalized);
    if (bucket) {
      bucket.ids.push(id);
    } else {
      buckets.set(normalized, {
        normalizedName: normalized,
        sampleRaw: String(raw).trim(),
        ids: [id],
      });
    }
  }

  // Filter, sort, project.
  const promotions: CounterpartyPromotion[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.ids.length < threshold) continue;
    promotions.push({
      normalizedName: bucket.normalizedName,
      sampleRaw: bucket.sampleRaw,
      supportCount: bucket.ids.length,
      exampleTransactionIds: bucket.ids.slice(0, 9),
    });
  }
  promotions.sort((a, b) => {
    if (a.supportCount !== b.supportCount) return b.supportCount - a.supportCount;
    return a.normalizedName.localeCompare(b.normalizedName);
  });
  return promotions.slice(0, COUNTERPARTY_PROMOTION_LIMIT);
}

// Re-export for tests that just want the model handle without importing
// from `../models`.
export { CashflowSettings };
