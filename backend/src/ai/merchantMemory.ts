import { QueryTypes, type Transaction as SequelizeTransaction } from 'sequelize';
import { sequelize } from '../models';
import { groupConcat } from '../util/dialectSql';

export type MerchantMemoryMatch = {
  merchantClean: string;
  category: string | null;
  business: boolean;
  splitType: string;
  pctMe: string | null;
  pctPartner: string | null;
  supportCount: number;
  exampleTransactionIds: number[];
  /**
   * True when this match was found among priors with similar amount + same
   * sign (within ±5% or ±$0.50, whichever is greater). False when this is
   * the fallback "any-amount" modal — less reliable for umbrella merchants
   * like Apple where amount disambiguates Apps from iCloud from Hardware.
   */
  matchedByAmount: boolean;
};

function normalizeMerchantKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

type MemoryRow = {
  merchantClean: string;
  category: string | null;
  business: number | boolean;
  splitType: string;
  pctMe: string | null;
  pctPartner: string | null;
  supportCount: string;
  exampleIds: string;
  lastReviewedAt: string;
};

async function queryMemory(opts: {
  householdId: number | null | undefined;
  merchantCleanLower: string;
  /** Optional sign + amount-window filter. */
  amountFilter: { sign: 1 | -1; minAbs: number; maxAbs: number } | null;
  transaction?: SequelizeTransaction;
}): Promise<MemoryRow | null> {
  const replacements: unknown[] = [
    opts.householdId ?? null,
    opts.householdId ?? null,
    opts.merchantCleanLower,
  ];
  let amountClause = '';
  if (opts.amountFilter) {
    amountClause = ` AND amount ${opts.amountFilter.sign > 0 ? '>' : '<'} 0 AND ABS(amount) BETWEEN ? AND ?`;
    replacements.push(opts.amountFilter.minAbs, opts.amountFilter.maxAbs);
  }
  const rows = await sequelize.query<MemoryRow>(
    `SELECT merchant_clean AS "merchantClean",
            final_category AS category,
            final_business AS business,
            final_split_type AS "splitType",
            final_pct_me AS "pctMe",
            final_pct_partner AS "pctPartner",
            COUNT(*) AS "supportCount",
            ${groupConcat('id')} AS "exampleIds",
            MAX(reviewed_at) AS "lastReviewedAt"
     FROM transactions
     WHERE (? IS NULL OR household_id = ?)
       AND LOWER(merchant_clean) = ?
       AND reviewed_at IS NOT NULL
       AND final_category IS NOT NULL${amountClause}
     GROUP BY merchant_clean, final_category, final_business, final_split_type, final_pct_me, final_pct_partner
     ORDER BY COUNT(*) DESC, MAX(reviewed_at) DESC
     LIMIT 1`,
    { replacements, type: QueryTypes.SELECT, transaction: opts.transaction },
  );
  return rows[0] ?? null;
}

function rowToMatch(row: MemoryRow, matchedByAmount: boolean): MerchantMemoryMatch {
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
    matchedByAmount,
  };
}

/**
 * Look up a categorisation for the given merchant from past reviewed
 * transactions. When `amount` is provided, prefer priors within ±5% (or
 * ±$0.50, whichever is greater) of that amount AND with the same sign —
 * this disambiguates umbrella merchants (Apple, Google, PayPal) where the
 * amount tells you the product. Falls back to any-amount modal when no
 * amount-bucketed priors exist.
 */
export async function findMerchantMemory(
  householdId: number | null | undefined,
  merchantClean: string,
  amount?: number | null,
  /** Thread the import transaction when calling from inside one so reads stay on the same connection. */
  options?: { transaction?: SequelizeTransaction },
): Promise<MerchantMemoryMatch | null> {
  const key = normalizeMerchantKey(merchantClean);
  if (!key) return null;
  const merchantCleanLower = merchantClean.toLowerCase();

  // First, try the amount-bucketed lookup if we have a usable amount.
  if (amount != null && Number.isFinite(amount) && amount !== 0) {
    const absAmount = Math.abs(amount);
    const tolerance = Math.max(0.5, absAmount * 0.05);
    const bucketed = await queryMemory({
      householdId,
      merchantCleanLower,
      amountFilter: {
        sign: amount > 0 ? 1 : -1,
        minAbs: Math.max(0, absAmount - tolerance),
        maxAbs: absAmount + tolerance,
      },
      transaction: options?.transaction,
    });
    if (bucketed && Number(bucketed.supportCount) >= 2) {
      return rowToMatch(bucketed, true);
    }
  }

  // Fall back to the original any-amount modal.
  const general = await queryMemory({
    householdId,
    merchantCleanLower,
    amountFilter: null,
    transaction: options?.transaction,
  });
  return general ? rowToMatch(general, false) : null;
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
