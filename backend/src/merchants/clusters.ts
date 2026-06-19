/**
 * Merchant-cleanup cluster service (issue #793).
 *
 * A "cluster" is a *derived view* — a `GROUP BY merchant_clean` aggregation
 * over the household's transactions for a single currency, mirroring the
 * grouping query that powers rule proposals
 * (`backend/src/ai/ruleProposals.ts`). There is NO new table and NO new
 * primitive: clusters are a read-side projection of the Transaction
 * primitive, and the bulk mutations here recategorize (`final_category`) or
 * reassign the canonical (`merchant_canonical`) of existing Transaction rows
 * plus optionally create an existing Rule row.
 *
 * Spend convention mirrors the rest of the app: purchases are negative
 * amounts, so per-cluster `totalSpend` is the sum of the absolute value of
 * negative-amount rows (positive amounts — refunds/credits — do not inflate
 * spend). Returned as a fixed(2) string for the wire format.
 */
import { QueryTypes } from 'sequelize';
import { sequelize } from '../models';
import { merchantPatternFor } from '../ai/ruleProposals';

export type CategorySpreadEntry = {
  category: string | null;
  count: number;
};

export type MerchantCluster = {
  merchantClean: string;
  /** Dominant canonical name for the cluster (merchant_canonical), or null. */
  canonical: string | null;
  count: number;
  /** Sum of absolute negative-amount (spend) rows, fixed(2) string. */
  totalSpend: string;
  currency: string;
  dominantCategory: string | null;
  categorySpread: CategorySpreadEntry[];
  sampleDescriptions: string[];
};

type ClusterAggRow = {
  merchantClean: string;
  canonical: string | null;
  count: string | number;
  totalSpend: string | number | null;
};

type CategoryRow = {
  merchantClean: string;
  category: string | null;
  count: string | number;
};

type SampleRow = {
  merchantClean: string;
  merchantRaw: string | null;
};

/**
 * List merchant clusters for the household, scoped to a single currency,
 * sorted by total spend descending. Each cluster carries its transaction
 * count, total spend, dominant canonical name, dominant category, the full
 * category spread, and a few sample raw descriptions.
 *
 * `householdId === null` means superadmin (no household filter).
 */
export async function listMerchantClusters(
  householdId: number | null,
  currency: string,
): Promise<MerchantCluster[]> {
  // 1. Per-cluster aggregate: count, spend, dominant canonical.
  // The dominant canonical is the most-frequent non-null merchant_canonical
  // for the cluster; computed in JS from the category/canonical rows below to
  // stay dialect-portable (no MODE() / window functions on SQLite).
  const aggRows = await sequelize.query<ClusterAggRow>(
    `SELECT merchant_clean AS "merchantClean",
            COUNT(*) AS "count",
            SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS "totalSpend"
       FROM transactions
      WHERE (? IS NULL OR household_id = ?)
        AND currency = ?
        AND TRIM(merchant_clean) != ''
      GROUP BY merchant_clean`,
    { replacements: [householdId, householdId, currency], type: QueryTypes.SELECT },
  );
  if (aggRows.length === 0) return [];

  // 2. Per-(cluster, category) counts → dominant category + spread.
  const categoryRows = await sequelize.query<CategoryRow>(
    `SELECT merchant_clean AS "merchantClean",
            final_category AS "category",
            COUNT(*) AS "count"
       FROM transactions
      WHERE (? IS NULL OR household_id = ?)
        AND currency = ?
        AND TRIM(merchant_clean) != ''
      GROUP BY merchant_clean, final_category`,
    { replacements: [householdId, householdId, currency], type: QueryTypes.SELECT },
  );

  // 3. Per-(cluster, canonical) counts → dominant canonical.
  const canonicalRows = await sequelize.query<CategoryRow>(
    `SELECT merchant_clean AS "merchantClean",
            merchant_canonical AS "category",
            COUNT(*) AS "count"
       FROM transactions
      WHERE (? IS NULL OR household_id = ?)
        AND currency = ?
        AND TRIM(merchant_clean) != ''
        AND merchant_canonical IS NOT NULL
        AND TRIM(merchant_canonical) != ''
      GROUP BY merchant_clean, merchant_canonical`,
    { replacements: [householdId, householdId, currency], type: QueryTypes.SELECT },
  );

  // 4. Sample raw descriptions (a few distinct merchant_raw per cluster).
  const sampleRows = await sequelize.query<SampleRow>(
    `SELECT DISTINCT merchant_clean AS "merchantClean",
            merchant_raw AS "merchantRaw"
       FROM transactions
      WHERE (? IS NULL OR household_id = ?)
        AND currency = ?
        AND TRIM(merchant_clean) != ''`,
    { replacements: [householdId, householdId, currency], type: QueryTypes.SELECT },
  );

  const spreadByClean = new Map<string, CategorySpreadEntry[]>();
  for (const row of categoryRows) {
    const list = spreadByClean.get(row.merchantClean) ?? [];
    list.push({ category: row.category, count: Number(row.count) || 0 });
    spreadByClean.set(row.merchantClean, list);
  }
  for (const list of spreadByClean.values()) {
    list.sort((a, b) => b.count - a.count);
  }

  const canonicalByClean = new Map<string, { name: string; count: number }>();
  for (const row of canonicalRows) {
    if (row.category == null) continue;
    const current = canonicalByClean.get(row.merchantClean);
    const count = Number(row.count) || 0;
    if (!current || count > current.count) {
      canonicalByClean.set(row.merchantClean, { name: row.category, count });
    }
  }

  const samplesByClean = new Map<string, string[]>();
  for (const row of sampleRows) {
    if (!row.merchantRaw) continue;
    const list = samplesByClean.get(row.merchantClean) ?? [];
    if (list.length < 3 && !list.includes(row.merchantRaw)) {
      list.push(row.merchantRaw);
      samplesByClean.set(row.merchantClean, list);
    }
  }

  const clusters: MerchantCluster[] = aggRows.map((row) => {
    const spread = spreadByClean.get(row.merchantClean) ?? [];
    const dominantCategory = spread.length > 0 ? spread[0].category : null;
    const canonical = canonicalByClean.get(row.merchantClean)?.name ?? null;
    const samples = samplesByClean.get(row.merchantClean) ?? [];
    return {
      merchantClean: row.merchantClean,
      canonical,
      count: Number(row.count) || 0,
      totalSpend: (Number(row.totalSpend) || 0).toFixed(2),
      currency,
      dominantCategory,
      categorySpread: spread,
      sampleDescriptions: samples,
    };
  });

  clusters.sort((a, b) => {
    const sa = Number(a.totalSpend);
    const sb = Number(b.totalSpend);
    if (sb !== sa) return sb - sa;
    return a.merchantClean.localeCompare(b.merchantClean);
  });

  return clusters;
}

/**
 * Derive the rule merchant-pattern for a cluster. Reuses the same trimming /
 * length cap that ruleProposals uses so a hand-built rule matches what the
 * proposal engine would have generated.
 */
export function clusterRulePattern(merchantClean: string): string {
  return merchantPatternFor(merchantClean);
}
