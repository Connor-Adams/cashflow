import crypto from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../models';
import { Rule } from '../models/Rule';
import { Transaction } from '../models/Transaction';
import { groupConcat, jsonExtractText } from '../util/dialectSql';

export type RuleProposal = {
  merchantPattern: string;
  category: string | null;
  isBusiness: boolean;
  splitType: string;
  pctMe: string | null;
  pctPartner: string | null;
  supportCount: number;
  exampleTransactionIds: number[];
};

/**
 * Confidence bucket for an auto-suggestion. Driven by the number of
 * consistent reviewed transactions backing the proposal: more support =
 * higher confidence that the user actually wants this rule on autopilot.
 */
export type SuggestionConfidence = 'high' | 'medium' | 'low';

/**
 * Single transaction surfaced as evidence for an auto-suggestion. Kept
 * intentionally lean — just enough for the UI to show "the rows this
 * suggestion came from" without re-fetching the full Transaction shape.
 */
export type SuggestionEvidence = {
  id: number;
  date: string;
  merchantClean: string;
  amount: string;
  currency: string;
  finalCategory: string | null;
  finalBusiness: boolean;
  finalSplitType: string;
};

/**
 * Shape returned by GET /api/rules/auto-suggestions. Extends RuleProposal
 * with: a stable deterministic `id` for accept/dismiss; a `confidence`
 * bucket; a human-readable `reasoning` string explaining why we surfaced
 * it; and an `evidence` array of the matched transactions.
 */
export type RuleAutoSuggestion = RuleProposal & {
  id: string;
  confidence: SuggestionConfidence;
  reasoning: string;
  evidence: SuggestionEvidence[];
};

/**
 * Canonical key for a proposal shape (merchant pattern + categorization
 * choice). Identifies the proposal independent of which transactions
 * happened to support it on a given query.
 */
export type ProposalShape = {
  merchantPattern: string;
  category: string | null;
  isBusiness: boolean;
  splitType: string;
  pctMe: string | null;
  pctPartner: string | null;
};

type RuleProposalRow = {
  merchantClean?: string;
  merchantclean?: string;
  category: string | null;
  isBusiness?: number | boolean;
  isbusiness?: number | boolean;
  splitType?: string;
  splittype?: string;
  pctMe?: string | null;
  pctme?: string | null;
  pctPartner?: string | null;
  pctpartner?: string | null;
  supportCount?: string | number;
  supportcount?: string | number;
  exampleIds?: string;
  exampleids?: string;
};

export function merchantPatternFor(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 120);
}

/**
 * Deterministic, URL-safe ID for a proposal shape. Same shape → same id,
 * regardless of how often or when we recompute the proposal set. Used by
 * /api/rules/auto-suggestions/:id/{accept,dismiss} so the client never
 * needs to URL-encode merchant text in the path.
 *
 * Normalizes the merchant pattern (case-fold + collapse whitespace) so
 * "  metro  grocery  " and "METRO GROCERY" hash to the same id. Other
 * fields are included as-is — split/category/business changes are
 * meaningful and must produce a distinct id.
 */
export function proposalIdFor(shape: ProposalShape): string {
  const normalizedPattern = merchantPatternFor(shape.merchantPattern).toUpperCase();
  const parts = [
    normalizedPattern,
    shape.category ?? '',
    shape.isBusiness ? '1' : '0',
    shape.splitType,
    shape.pctMe ?? '',
    shape.pctPartner ?? '',
  ].join('|');
  return crypto.createHash('sha1').update(parts).digest('base64url').slice(0, 16);
}

/**
 * Maps a transaction-support count to a confidence bucket. Thresholds:
 * 5+ = high (very stable pattern), 3-4 = medium (the minimum for surfacing,
 * still solid), <3 = low (should not appear at all under findRuleProposals
 * but kept for completeness in case callers construct shapes manually).
 */
export function confidenceForSupport(supportCount: number): SuggestionConfidence {
  if (supportCount >= 5) return 'high';
  if (supportCount >= 3) return 'medium';
  return 'low';
}

function formatSplitDescription(
  splitType: string,
  pctMe: string | null,
  pctPartner: string | null,
): string {
  if (splitType === 'shared' && pctMe != null && pctPartner != null) {
    const me = Math.round(Number(pctMe) * 100);
    const partner = Math.round(Number(pctPartner) * 100);
    return `shared ${me}/${partner}`;
  }
  return splitType;
}

/**
 * Human-readable explanation of why a proposal is being surfaced. Shown
 * to the user as the suggestion's "reasoning" so they can audit the
 * recommendation before clicking Accept.
 */
export function buildSuggestionReasoning(
  shape: ProposalShape & { supportCount: number },
): string {
  const categoryFragment = shape.category
    ? `as "${shape.category}"`
    : 'as uncategorized';
  const businessFragment = shape.isBusiness ? ' (business)' : '';
  const splitFragment =
    shape.splitType !== 'me'
      ? ` with ${formatSplitDescription(shape.splitType, shape.pctMe, shape.pctPartner)} split`
      : '';
  return `You categorized ${shape.supportCount} reviewed transactions for "${shape.merchantPattern}" ${categoryFragment}${businessFragment}${splitFragment} with no exceptions.`;
}

export function ruleProposalFromRow(row: RuleProposalRow): RuleProposal {
  const merchantClean = row.merchantClean ?? row.merchantclean ?? '';
  const isBusiness = row.isBusiness ?? row.isbusiness ?? false;
  const splitType = row.splitType ?? row.splittype ?? 'me';
  const pctMe = row.pctMe ?? row.pctme ?? null;
  const pctPartner = row.pctPartner ?? row.pctpartner ?? null;
  const supportCount = row.supportCount ?? row.supportcount ?? 0;
  const exampleIds = row.exampleIds ?? row.exampleids ?? '';

  return {
    merchantPattern: merchantPatternFor(merchantClean),
    category: row.category,
    isBusiness: Boolean(isBusiness),
    splitType,
    pctMe: pctMe == null ? null : String(pctMe),
    pctPartner: pctPartner == null ? null : String(pctPartner),
    supportCount: Number(supportCount) || 0,
    exampleTransactionIds: String(exampleIds || '')
      .split(',')
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id))
      .slice(0, 8),
  };
}

/**
 * Loads the evidence transactions for an auto-suggestion in the same
 * order as the example-id list. Returns up to `limit` rows; caller is
 * expected to pass the already-decoded `exampleTransactionIds` array.
 * Scoped by householdId when non-null so non-superadmin callers can't
 * see cross-household rows.
 */
async function loadEvidenceTransactions(
  exampleIds: number[],
  householdId: number | null,
  limit: number,
): Promise<SuggestionEvidence[]> {
  if (exampleIds.length === 0) return [];
  const trimmed = exampleIds.slice(0, limit);
  const where: Record<string, unknown> = { id: trimmed };
  if (householdId != null) where.householdId = householdId;
  const txns = await Transaction.findAll({
    where: where as never,
    attributes: [
      'id',
      'date',
      'merchantClean',
      'amount',
      'currency',
      'finalCategory',
      'finalBusiness',
      'finalSplitType',
    ],
  });
  // Preserve the order of `trimmed` rather than DB-row order so the UI's
  // "first few examples" reads as deterministic.
  const byId = new Map(txns.map((t) => [t.id, t]));
  return trimmed
    .map((id) => byId.get(id))
    .filter((t): t is Transaction => t != null)
    .map((t) => ({
      id: t.id,
      date: t.date,
      merchantClean: t.merchantClean,
      amount: String(t.amount),
      currency: t.currency,
      finalCategory: t.finalCategory,
      finalBusiness: t.finalBusiness,
      finalSplitType: t.finalSplitType,
    }));
}

/**
 * Decorates a `RuleProposal` with the stable ID + confidence bucket +
 * reasoning string + evidence transactions, producing the shape returned
 * by GET /api/rules/auto-suggestions. Evidence is loaded per proposal so
 * callers should batch via `findAutoSuggestions` rather than fanning out.
 */
export function decorateProposal(
  proposal: RuleProposal,
  evidence: SuggestionEvidence[],
): RuleAutoSuggestion {
  return {
    ...proposal,
    id: proposalIdFor(proposal),
    confidence: confidenceForSupport(proposal.supportCount),
    reasoning: buildSuggestionReasoning(proposal),
    evidence,
  };
}

/**
 * Returns the full auto-suggestion set for a household, including
 * confidence + reasoning + evidence transactions ready for the UI.
 * Caps evidence at 5 transactions per suggestion to keep the payload
 * compact (the underlying proposal can be backed by many more rows;
 * supportCount is the authoritative total).
 */
export async function findAutoSuggestions(
  householdId: number | null,
): Promise<RuleAutoSuggestion[]> {
  const proposals = await findRuleProposals(householdId);
  const decorated: RuleAutoSuggestion[] = [];
  for (const proposal of proposals) {
    const evidence = await loadEvidenceTransactions(
      proposal.exampleTransactionIds,
      householdId,
      5,
    );
    decorated.push(decorateProposal(proposal, evidence));
  }
  return decorated;
}

/**
 * Finds an auto-suggestion by its stable id from the current proposal
 * set. Returns null if no proposal with that id is currently surfaced —
 * which happens when the underlying transactions changed, the rule was
 * already created, or the suggestion was dismissed.
 */
export async function findAutoSuggestionById(
  householdId: number | null,
  id: string,
): Promise<RuleAutoSuggestion | null> {
  const suggestions = await findAutoSuggestions(householdId);
  return suggestions.find((s) => s.id === id) ?? null;
}

export async function findRuleProposals(householdId: number | null): Promise<RuleProposal[]> {
  const rows = await sequelize.query<RuleProposalRow>(
    `SELECT merchant_clean AS "merchantClean",
            final_category AS category,
            final_business AS "isBusiness",
            final_split_type AS "splitType",
            final_pct_me AS "pctMe",
            final_pct_partner AS "pctPartner",
            COUNT(*) AS "supportCount",
            ${groupConcat('id')} AS "exampleIds"
     FROM transactions
     WHERE (? IS NULL OR household_id = ?)
       AND reviewed_at IS NOT NULL
       AND final_category IS NOT NULL
       AND TRIM(merchant_clean) != ''
     GROUP BY merchant_clean, final_category, final_business, final_split_type, final_pct_me, final_pct_partner
     HAVING COUNT(*) >= 3
     ORDER BY COUNT(*) DESC, merchant_clean ASC
     LIMIT 20`,
    { replacements: [householdId, householdId], type: QueryTypes.SELECT },
  );
  const [existingRules, dismissed] = await Promise.all([
    Rule.findAll({
      where: householdId == null ? undefined : { householdId },
      attributes: ['merchantPattern'],
      raw: true,
    }),
    sequelize.query<{ pattern: string }>(
      `SELECT ${jsonExtractText('input_snapshot', 'merchantPattern')} AS pattern
         FROM ai_suggestions
        WHERE kind = 'rule_proposal'
          AND status = 'rejected'
          AND (? IS NULL OR household_id = ?)`,
      { replacements: [householdId, householdId], type: QueryTypes.SELECT },
    ),
  ]);
  const existing = new Set(
    existingRules.map((r) => String(r.merchantPattern).trim().toLowerCase()),
  );
  const rejected = new Set(
    dismissed
      .map((r) => merchantPatternFor(r.pattern || '').toLowerCase())
      .filter((p) => p.length > 0),
  );
  return rows
    .map(ruleProposalFromRow)
    .filter((p) => !existing.has(p.merchantPattern.toLowerCase()))
    .filter((p) => !rejected.has(p.merchantPattern.toLowerCase()));
}
