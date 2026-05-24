import { QueryTypes } from 'sequelize';
import { sequelize } from '../models';
import { Rule } from '../models/Rule';

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
            GROUP_CONCAT(id) AS "exampleIds"
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
      `SELECT json_extract(input_snapshot, '$.merchantPattern') AS pattern
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
