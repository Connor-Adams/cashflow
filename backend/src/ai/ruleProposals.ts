import crypto from 'crypto';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../models';
import { Rule } from '../models/Rule';
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

/**
 * Auto-rule suggestion: a {@link RuleProposal} enriched with the signals an
 * end-user needs to decide whether to accept the suggestion as a real rule.
 *
 * - `id`: stable deterministic hash over the proposal's defining fields so
 *   accept/dismiss endpoints can identify a suggestion across requests.
 * - `confidence`: 0..1, fraction of this merchant's reviewed transactions
 *   that landed on this exact category (signal consistency).
 * - `reasoning`: human-readable string explaining the confidence number.
 *
 * Behavioural pattern detection per issue #211 — surface the cases where the
 * user has manually categorised the same merchant 3+ times in a consistent
 * way, suggesting that a one-time rule would automate future imports.
 */
export type AutoRuleSuggestion = RuleProposal & {
  id: string;
  confidence: number;
  reasoning: string;
};

/**
 * Default minimum confidence to surface a suggestion. Anything below this is
 * considered noise — the merchant's categorisations are too mixed for a
 * single-rule recommendation to be useful.
 */
export const AUTO_SUGGESTION_MIN_CONFIDENCE = 0.8;

/**
 * Stable deterministic ID for an auto-rule suggestion. The same proposal
 * across requests must hash to the same string, otherwise the accept/dismiss
 * URL would be a moving target.
 */
export function autoRuleSuggestionId(p: RuleProposal): string {
  const parts = [
    p.merchantPattern,
    p.category ?? '',
    p.isBusiness ? '1' : '0',
    p.splitType,
    p.pctMe ?? '',
    p.pctPartner ?? '',
  ];
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

type MerchantTotalsRow = {
  merchantClean?: string;
  merchantclean?: string;
  total?: string | number;
};

/**
 * Find behavioural pattern-based rule suggestions for the household.
 *
 * Builds on {@link findRuleProposals}: 3+ reviewed transactions with a
 * consistent merchant+category+split shape, no current matching rule, not
 * previously dismissed. Adds per-merchant confidence (fraction of this
 * merchant's reviewed rows that share the proposal's category) and filters
 * out anything below {@link AUTO_SUGGESTION_MIN_CONFIDENCE}.
 */
export async function findAutoRuleSuggestions(
  householdId: number | null,
): Promise<AutoRuleSuggestion[]> {
  const proposals = await findRuleProposals(householdId);
  if (proposals.length === 0) return [];

  // Total reviewed-and-categorised rows per merchant_clean so we can compute
  // confidence = supportCount / total. Constrained to the same WHERE clause
  // as findRuleProposals so the denominator matches the numerator.
  const totalsRows = await sequelize.query<MerchantTotalsRow>(
    `SELECT merchant_clean AS "merchantClean", COUNT(*) AS total
       FROM transactions
      WHERE (? IS NULL OR household_id = ?)
        AND reviewed_at IS NOT NULL
        AND final_category IS NOT NULL
        AND TRIM(merchant_clean) != ''
      GROUP BY merchant_clean`,
    { replacements: [householdId, householdId], type: QueryTypes.SELECT },
  );
  const totals = new Map<string, number>();
  for (const row of totalsRows) {
    const key = merchantPatternFor(row.merchantClean ?? row.merchantclean ?? '').toLowerCase();
    if (!key) continue;
    totals.set(key, Number(row.total ?? 0) || 0);
  }

  return proposals
    .map((p): AutoRuleSuggestion | null => {
      const total = totals.get(p.merchantPattern.toLowerCase()) ?? p.supportCount;
      if (total <= 0) return null;
      const confidence = Math.min(1, p.supportCount / total);
      if (confidence < AUTO_SUGGESTION_MIN_CONFIDENCE) return null;
      const reasoning =
        `${p.supportCount} of ${total} reviewed transactions for ` +
        `"${p.merchantPattern}" use this category` +
        (p.category ? ` (${p.category})` : '');
      return {
        ...p,
        id: autoRuleSuggestionId(p),
        // Round to two decimals so the wire format is predictable for UI
        // confidence badges; the raw value is fine but trim trailing noise.
        confidence: Math.round(confidence * 100) / 100,
        reasoning,
      };
    })
    .filter((s): s is AutoRuleSuggestion => s != null);
}
