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
 *
 * The route layer (`backend/src/routes/merchants.ts`) is intentionally thin:
 * it validates request input and then calls the service functions here with
 * already-validated arguments. Keeping the privileged DB mutations behind a
 * service boundary (rather than guarded inline by raw request-body values)
 * also keeps the request handlers simple and free of user-controlled-bypass
 * dataflow.
 */
import { Op, QueryTypes } from 'sequelize';
import { sequelize, Transaction, Rule } from '../models';
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
  count: string | number;
  totalSpend: string | number | null;
};

type GroupCountRow = {
  merchantClean: string;
  value: string | null;
  count: string | number;
};

type SampleRow = {
  merchantClean: string;
  merchantRaw: string | null;
};

/**
 * The four GROUP BY passes that build the cluster view. Split out so the
 * assembling function stays flat. All run on the same WHERE clause (household
 * + currency + non-blank merchant_clean) and are dialect-portable.
 */
async function fetchClusterRows(
  householdId: number | null,
  currency: string,
): Promise<{
  agg: ClusterAggRow[];
  categories: GroupCountRow[];
  canonicals: GroupCountRow[];
  samples: SampleRow[];
}> {
  const replacements = [householdId, householdId, currency];
  const [agg, categories, canonicals, samples] = await Promise.all([
    sequelize.query<ClusterAggRow>(
      `SELECT merchant_clean AS "merchantClean",
              COUNT(*) AS "count",
              SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS "totalSpend"
         FROM transactions
        WHERE (? IS NULL OR household_id = ?)
          AND currency = ?
          AND TRIM(merchant_clean) != ''
        GROUP BY merchant_clean`,
      { replacements, type: QueryTypes.SELECT },
    ),
    sequelize.query<GroupCountRow>(
      `SELECT merchant_clean AS "merchantClean",
              final_category AS "value",
              COUNT(*) AS "count"
         FROM transactions
        WHERE (? IS NULL OR household_id = ?)
          AND currency = ?
          AND TRIM(merchant_clean) != ''
        GROUP BY merchant_clean, final_category`,
      { replacements, type: QueryTypes.SELECT },
    ),
    sequelize.query<GroupCountRow>(
      `SELECT merchant_clean AS "merchantClean",
              merchant_canonical AS "value",
              COUNT(*) AS "count"
         FROM transactions
        WHERE (? IS NULL OR household_id = ?)
          AND currency = ?
          AND TRIM(merchant_clean) != ''
          AND merchant_canonical IS NOT NULL
          AND TRIM(merchant_canonical) != ''
        GROUP BY merchant_clean, merchant_canonical`,
      { replacements, type: QueryTypes.SELECT },
    ),
    sequelize.query<SampleRow>(
      `SELECT DISTINCT merchant_clean AS "merchantClean",
              merchant_raw AS "merchantRaw"
         FROM transactions
        WHERE (? IS NULL OR household_id = ?)
          AND currency = ?
          AND TRIM(merchant_clean) != ''`,
      { replacements, type: QueryTypes.SELECT },
    ),
  ]);
  return { agg, categories, canonicals, samples };
}

/** Per-cluster category spread (descending by count). */
function buildSpread(rows: GroupCountRow[]): Map<string, CategorySpreadEntry[]> {
  const byClean = new Map<string, CategorySpreadEntry[]>();
  for (const row of rows) {
    const list = byClean.get(row.merchantClean) ?? [];
    list.push({ category: row.value, count: Number(row.count) || 0 });
    byClean.set(row.merchantClean, list);
  }
  for (const list of byClean.values()) list.sort((a, b) => b.count - a.count);
  return byClean;
}

/** Per-cluster dominant (most-frequent non-null) canonical name. */
function buildDominantCanonical(rows: GroupCountRow[]): Map<string, string> {
  const byClean = new Map<string, { name: string; count: number }>();
  for (const row of rows) {
    if (row.value == null) continue;
    const count = Number(row.count) || 0;
    const current = byClean.get(row.merchantClean);
    if (!current || count > current.count) {
      byClean.set(row.merchantClean, { name: row.value, count });
    }
  }
  const out = new Map<string, string>();
  for (const [clean, v] of byClean) out.set(clean, v.name);
  return out;
}

/** Up to three distinct sample raw descriptions per cluster. */
function buildSamples(rows: SampleRow[]): Map<string, string[]> {
  const byClean = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.merchantRaw) continue;
    const list = byClean.get(row.merchantClean) ?? [];
    if (list.length < 3 && !list.includes(row.merchantRaw)) {
      list.push(row.merchantRaw);
      byClean.set(row.merchantClean, list);
    }
  }
  return byClean;
}

/**
 * List merchant clusters for the household, scoped to a single currency,
 * sorted by total spend descending. `householdId === null` means superadmin
 * (no household filter).
 */
export async function listMerchantClusters(
  householdId: number | null,
  currency: string,
): Promise<MerchantCluster[]> {
  const { agg, categories, canonicals, samples } = await fetchClusterRows(
    householdId,
    currency,
  );
  if (agg.length === 0) return [];

  const spreadByClean = buildSpread(categories);
  const canonicalByClean = buildDominantCanonical(canonicals);
  const samplesByClean = buildSamples(samples);

  const clusters: MerchantCluster[] = agg.map((row) => {
    const spread = spreadByClean.get(row.merchantClean) ?? [];
    return {
      merchantClean: row.merchantClean,
      canonical: canonicalByClean.get(row.merchantClean) ?? null,
      count: Number(row.count) || 0,
      totalSpend: (Number(row.totalSpend) || 0).toFixed(2),
      currency,
      dominantCategory: spread.length > 0 ? spread[0].category : null,
      categorySpread: spread,
      sampleDescriptions: samplesByClean.get(row.merchantClean) ?? [],
    };
  });

  clusters.sort((a, b) => {
    const diff = Number(b.totalSpend) - Number(a.totalSpend);
    return diff !== 0 ? diff : a.merchantClean.localeCompare(b.merchantClean);
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

// ── Bulk mutation services (called with pre-validated args) ───────────────

export type BulkRecategorizeArgs = {
  householdId: number;
  createdByUserId: number;
  /** Validated, trimmed, non-empty cluster key. */
  merchantClean: string;
  /** Validated category name (already confirmed to exist for the household). */
  category: string;
  createRule: boolean;
};

export type BulkRecategorizeResult =
  | { ok: true; recategorized: number; ruleCreated: boolean; ruleId: number | null }
  | { ok: false; reason: 'no_match' | 'rule_exists'; ruleId?: number };

/**
 * Set `final_category` on every transaction in the cluster for the household.
 * Optionally create a substring Rule from the cluster pattern (idempotent —
 * returns `rule_exists` if a rule with the same pattern already exists).
 *
 * Rows are loaded and saved individually so the Transaction `beforeSave`
 * category-reconciliation hook fires (keeps `final_category_id` in sync).
 */
export async function bulkRecategorize(
  args: BulkRecategorizeArgs,
): Promise<BulkRecategorizeResult> {
  const scope = { householdId: args.householdId, merchantClean: args.merchantClean };
  const matchCount = await Transaction.count({ where: scope });
  if (matchCount === 0) return { ok: false, reason: 'no_match' };

  const pattern = clusterRulePattern(args.merchantClean);
  if (args.createRule) {
    const existing = await Rule.findOne({
      where: { householdId: args.householdId, merchantPattern: pattern },
      attributes: ['id'],
    });
    if (existing) return { ok: false, reason: 'rule_exists', ruleId: existing.id };
  }

  let ruleId: number | null = null;
  await sequelize.transaction(async (t) => {
    const rows = await Transaction.findAll({ where: scope, transaction: t });
    for (const row of rows) {
      row.set('finalCategory', args.category);
      await row.save({ transaction: t });
    }
    if (args.createRule) {
      const rule = await Rule.create(
        {
          merchantPattern: pattern,
          householdId: args.householdId,
          createdByUserId: args.createdByUserId,
          matchKind: 'substring',
          priority: 0,
          category: args.category,
          isBusiness: false,
          splitType: 'me',
          pctMe: null,
          pctPartner: null,
          effectiveFrom: null,
          effectiveTo: null,
        },
        { transaction: t },
      );
      ruleId = rule.id;
    }
  });

  return { ok: true, recategorized: matchCount, ruleCreated: args.createRule, ruleId };
}

export type MergeArgs = {
  householdId: number;
  /** Validated, trimmed survivor cluster key. */
  survivorMerchantClean: string;
  /** Validated, trimmed merge cluster keys (survivor excluded by caller). */
  mergeMerchantCleans: string[];
  /** Optional explicit canonical override (already length-checked). */
  canonicalName: string;
};

export type MergeResult =
  | { ok: true; reassigned: number; survivor: string }
  | { ok: false; reason: 'survivor_missing' | 'cluster_missing'; cluster?: string };

/**
 * Compute the surviving canonical name: an explicit override wins; otherwise
 * reuse the survivor cluster's existing dominant canonical, falling back to
 * its merchant_clean. Capped to 160 chars (matches Contact.name).
 */
async function resolveSurvivorCanonical(
  householdId: number,
  survivor: string,
  override: string,
): Promise<string> {
  if (override) return override.slice(0, 160);
  const existing = await Transaction.findOne({
    where: { householdId, merchantClean: survivor, merchantCanonical: { [Op.ne]: null } },
    attributes: ['merchantCanonical'],
    order: [['id', 'ASC']],
  });
  return (existing?.merchantCanonical?.trim() || survivor).slice(0, 160);
}

/**
 * Reassign the canonical of every transaction in the survivor + merge
 * clusters to the resolved survivor canonical. A rename-only call (empty
 * merge list) updates only the survivor cluster.
 */
export async function mergeMerchants(args: MergeArgs): Promise<MergeResult> {
  const survivorCount = await Transaction.count({
    where: { householdId: args.householdId, merchantClean: args.survivorMerchantClean },
  });
  if (survivorCount === 0) return { ok: false, reason: 'survivor_missing' };

  for (const clean of args.mergeMerchantCleans) {
    const c = await Transaction.count({
      where: { householdId: args.householdId, merchantClean: clean },
    });
    if (c === 0) return { ok: false, reason: 'cluster_missing', cluster: clean };
  }

  const canonical = await resolveSurvivorCanonical(
    args.householdId,
    args.survivorMerchantClean,
    args.canonicalName,
  );

  let reassigned = 0;
  await sequelize.transaction(async (t) => {
    const cleans = [args.survivorMerchantClean, ...args.mergeMerchantCleans];
    const rows = await Transaction.findAll({
      where: { householdId: args.householdId, merchantClean: { [Op.in]: cleans } },
      transaction: t,
    });
    for (const row of rows) {
      if (row.merchantCanonical === canonical) continue;
      row.set('merchantCanonical', canonical);
      await row.save({ transaction: t });
      reassigned += 1;
    }
  });

  return { ok: true, reassigned, survivor: canonical };
}
