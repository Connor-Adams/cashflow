/**
 * Past user corrections for a merchant, for use as few-shot negatives.
 *
 * `suggestionStore.ts` scores every suggestion against what the user finally
 * chose and persists status='edited' plus per-field mismatch booleans. That is
 * a labeled record of what the model gets wrong on this household's merchants,
 * and until now nothing read it back into a prompt.
 */
import { AiSuggestion } from '../models';
import { normalizeMerchantKey } from './merchantMemory';
import { num } from '../util/numbers';

export interface CorrectionFields {
  category: string | null;
  business: boolean | null;
  splitType: string | null;
  pctMe: number | null;
  pctPartner: number | null;
}

export interface PastCorrection {
  suggestionId: number;
  suggested: CorrectionFields;
  corrected: CorrectionFields;
  mismatchedFields: string[];
}

const METRIC_TO_FIELD: Record<string, string> = {
  categoryMatch: 'category',
  businessMatch: 'business',
  splitTypeMatch: 'splitType',
  pctMeMatch: 'pctMe',
  pctPartnerMatch: 'pctPartner',
};

function fields(source: unknown): CorrectionFields {
  const o = (source ?? {}) as Record<string, unknown>;
  return {
    category: typeof o.category === 'string' ? o.category : null,
    business: typeof o.business === 'boolean' ? o.business : null,
    splitType: typeof o.splitType === 'string' ? o.splitType : null,
    pctMe: num(o.pctMe),
    pctPartner: num(o.pctPartner),
  };
}

function mismatchedFrom(finalSnapshot: unknown): string[] {
  const metrics = (finalSnapshot as { metrics?: Record<string, unknown> } | null)
    ?.metrics;
  if (!metrics || typeof metrics !== 'object') return [];
  const out: string[] = [];
  for (const [metric, field] of Object.entries(METRIC_TO_FIELD)) {
    if (metrics[metric] === false) out.push(field);
  }
  return out;
}

export async function findPastCorrections(
  householdId: number | null | undefined,
  merchant: string | null,
  limit = 5,
): Promise<PastCorrection[]> {
  if (!merchant || !merchant.trim()) return [];
  const key = normalizeMerchantKey(merchant);
  if (!key) return [];

  // The merchant lives inside the JSON input snapshot, and JSON extraction
  // differs between SQLite and Postgres — so filter in JS over a bounded
  // recent window rather than in SQL. Do NOT use `raw: true` here: on SQLite
  // it returns JSON columns as unparsed strings, silently breaking the
  // merchant match below.
  //
  // The 200-row window is a recency cap, not a merchant-scoped limit: a
  // merchant whose matching corrections all fall outside the 200 most recent
  // edited suggestions (across all merchants) silently yields fewer than
  // `limit` results, or none, even if older corrections exist for it.
  const rows = await AiSuggestion.findAll({
    where: {
      kind: 'transaction_fields',
      status: 'edited',
      ...(householdId != null ? { householdId } : {}),
    },
    order: [['id', 'DESC']],
    limit: 200,
  });

  const out: PastCorrection[] = [];
  for (const row of rows) {
    const data = row.toJSON();
    const snapshot = data.inputSnapshot as
      | { transaction?: { merchantClean?: unknown; merchantRaw?: unknown } }
      | null;
    const raw =
      typeof snapshot?.transaction?.merchantClean === 'string'
        ? snapshot.transaction.merchantClean
        : typeof snapshot?.transaction?.merchantRaw === 'string'
          ? snapshot.transaction.merchantRaw
          : null;
    if (!raw || normalizeMerchantKey(raw) !== key) continue;

    out.push({
      suggestionId: data.id,
      suggested: fields(data.output),
      corrected: fields(data.finalSnapshot),
      mismatchedFields: mismatchedFrom(data.finalSnapshot),
    });
    if (out.length >= limit) break;
  }
  return out;
}
