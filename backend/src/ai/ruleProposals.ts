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

function merchantPatternFor(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 120);
}

export async function findRuleProposals(householdId: number | null): Promise<RuleProposal[]> {
  const rows = await sequelize.query<{
    merchantClean: string;
    category: string | null;
    isBusiness: number | boolean;
    splitType: string;
    pctMe: string | null;
    pctPartner: string | null;
    supportCount: string;
    exampleIds: string;
  }>(
    `SELECT merchant_clean AS merchantClean,
            final_category AS category,
            final_business AS isBusiness,
            final_split_type AS splitType,
            final_pct_me AS pctMe,
            final_pct_partner AS pctPartner,
            COUNT(*) AS supportCount,
            GROUP_CONCAT(id) AS exampleIds
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
  const existingRules = await Rule.findAll({
    where: householdId == null ? undefined : { householdId },
    attributes: ['merchantPattern'],
    raw: true,
  });
  const existing = new Set(
    existingRules.map((r) => String(r.merchantPattern).trim().toLowerCase()),
  );
  return rows
    .map((row) => ({
      merchantPattern: merchantPatternFor(row.merchantClean),
      category: row.category,
      isBusiness: Boolean(row.isBusiness),
      splitType: row.splitType,
      pctMe: row.pctMe == null ? null : String(row.pctMe),
      pctPartner: row.pctPartner == null ? null : String(row.pctPartner),
      supportCount: Number(row.supportCount) || 0,
      exampleTransactionIds: String(row.exampleIds || '')
        .split(',')
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id))
        .slice(0, 8),
    }))
    .filter((p) => !existing.has(p.merchantPattern.toLowerCase()));
}
