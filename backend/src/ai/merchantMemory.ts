import { QueryTypes } from 'sequelize';
import { sequelize } from '../models';

export type MerchantMemoryMatch = {
  merchantClean: string;
  category: string | null;
  business: boolean;
  splitType: string;
  pctMe: string | null;
  pctPartner: string | null;
  supportCount: number;
  exampleTransactionIds: number[];
};

function normalizeMerchantKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export async function findMerchantMemory(
  householdId: number | null | undefined,
  merchantClean: string,
): Promise<MerchantMemoryMatch | null> {
  const key = normalizeMerchantKey(merchantClean);
  if (!key) return null;
  const rows = await sequelize.query<{
    merchantClean: string;
    category: string | null;
    business: number | boolean;
    splitType: string;
    pctMe: string | null;
    pctPartner: string | null;
    supportCount: string;
    exampleIds: string;
    lastReviewedAt: string;
  }>(
    `SELECT merchant_clean AS merchantClean,
            final_category AS category,
            final_business AS business,
            final_split_type AS splitType,
            final_pct_me AS pctMe,
            final_pct_partner AS pctPartner,
            COUNT(*) AS supportCount,
            GROUP_CONCAT(id) AS exampleIds,
            MAX(reviewed_at) AS lastReviewedAt
     FROM transactions
     WHERE (? IS NULL OR household_id = ?)
       AND LOWER(merchant_clean) = ?
       AND reviewed_at IS NOT NULL
       AND final_category IS NOT NULL
     GROUP BY merchant_clean, final_category, final_business, final_split_type, final_pct_me, final_pct_partner
     ORDER BY COUNT(*) DESC, MAX(reviewed_at) DESC
     LIMIT 1`,
    {
      replacements: [householdId ?? null, householdId ?? null, merchantClean.toLowerCase()],
      type: QueryTypes.SELECT,
    },
  );
  const row = rows[0];
  if (!row) return null;
  return {
    merchantClean: row.merchantClean,
    category: row.category,
    business: Boolean(row.business),
    splitType: row.splitType,
    pctMe: row.pctMe == null ? null : String(row.pctMe),
    pctPartner: row.pctPartner == null ? null : String(row.pctPartner),
    supportCount: Number(row.supportCount) || 0,
    exampleTransactionIds: String(row.exampleIds || '')
      .split(',')
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id))
      .slice(0, 8),
  };
}

export function merchantMemoryToAutoFields(match: MerchantMemoryMatch): {
  autoCategory: string | null;
  autoBusiness: boolean;
  autoSplitType: string;
  autoPctMe: string | null;
  autoPctPartner: string | null;
} {
  return {
    autoCategory: match.category,
    autoBusiness: match.business,
    autoSplitType: match.splitType,
    autoPctMe: match.pctMe,
    autoPctPartner: match.pctPartner,
  };
}
