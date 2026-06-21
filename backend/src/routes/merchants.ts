/**
 * Merchant timeline routes (issue #219).
 *
 * Three GET endpoints powering the per-merchant detail page:
 *
 *   GET /api/merchants?search=&currency=&limit=
 *     Top merchants by lifetime net spend across the visible transaction
 *     scope. Optional `search` does a case-insensitive substring match on
 *     merchantCanonical/merchantClean/merchantRaw; optional `currency`
 *     filters to a single ISO code.
 *
 *   GET /api/merchants/:name?currency=
 *     Full timeline for one merchant — totals, monthly trend, category
 *     breakdown, receipt coverage, related rules, recurring flag, plus the
 *     set of available currencies for the merchant. `:name` is the URL-
 *     decoded merchant key as it appears in
 *     `aggregateDashboard`'s `merchantSummaries[].merchant`. We match rows
 *     by `merchantCanonical = name OR merchantClean = name OR
 *     merchantRaw = name` so canonical-mapped and unmapped variants of the
 *     same brand aggregate together.
 *
 *   GET /api/merchants/:name/transactions?currency=&page=&pageSize=
 *     Paginated transactions for the merchant, descending by date.
 *
 * Every handler reads `currentAuth(req)` (via visibleTransactionWhere /
 * visibleAccountWhere), so each route uses `aiSuggestLimiter` to avoid
 * CodeQL's diff-aware "missing rate limiting" alert on new authenticated
 * endpoints (see kindex concept 8ce570063082).
 */
import { Router, type Request } from 'express';
import { Op, fn, col, where as sqlWhere, QueryTypes } from 'sequelize';
import { Account, Category, Receipt, Rule, Transaction, sequelize } from '../models';
import { serializeTransaction } from '../util/serializeTransaction';
import {
  aggregateMerchantTimeline,
  resolveMerchantKey,
  type MerchantTimelineTxnRow,
} from '../summary/merchantTimeline';
import {
  visibleTransactionWhere,
  visibleAccountWhere,
  householdWhere,
  isSuperadmin,
} from '../auth/scope';
import { currentAuth } from '../auth/middleware';
import { defaultCurrency } from '../config/env';
import { FxRate } from '../models/FxRate';
import {
  listMerchantClusters,
  bulkRecategorize,
  mergeMerchants,
} from '../merchants/clusters';
import { aiSuggestLimiter } from './aiRateLimit';

const router = Router();

function parseCurrency(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  return String(raw).toUpperCase().slice(0, 3);
}

function merchantMatchWhere(name: string): Record<symbol | string, unknown> {
  // Match the merchant key against any of the three merchant columns so
  // canonical-mapped rows (`merchantCanonical = "Tim Hortons"`) group with
  // unmapped variants that still report a clean/raw value matching the
  // user-visible merchant key.
  return {
    [Op.or]: [
      { merchantCanonical: name },
      { merchantClean: name },
      { merchantRaw: name },
    ],
  };
}

/**
 * Top merchants list. Walks visible transactions, groups by
 * (currency, resolvedMerchantKey), and returns the top N by net spend.
 *
 * Computed entirely in memory because the resolved merchant key is a JS
 * COALESCE across three columns; pushing that into the database would
 * require a stored function (and would still need to mirror the JS
 * trim/blank-fallback logic).
 */
router.get('/', aiSuggestLimiter, async (req, res, next) => {
  try {
    const search = req.query.search ? String(req.query.search).trim() : '';
    const currency = parseCurrency(req.query.currency);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));

    const where: Record<string, unknown> = { ...visibleTransactionWhere(req) };
    if (currency) where.currency = currency;
    if (search) {
      const like = `%${search.toLowerCase()}%`;
      where[Op.and as unknown as string] = [
        {
          [Op.or]: [
            sqlWhere(fn('LOWER', col('merchant_canonical')), { [Op.like]: like }),
            sqlWhere(fn('LOWER', col('merchant_clean')), { [Op.like]: like }),
            sqlWhere(fn('LOWER', col('merchant_raw')), { [Op.like]: like }),
          ],
        },
      ];
    }

    const rows = (await Transaction.findAll({
      where,
      attributes: [
        'id',
        'accountId',
        'date',
        'currency',
        'finalCategory',
        'finalBusiness',
        'finalSplitType',
        'merchantRaw',
        'merchantClean',
        'merchantCanonical',
        'amount',
        'txnType',
        'isRecurring',
      ],
      raw: true,
    })) as unknown as Array<MerchantTimelineTxnRow & { accountType?: string | null }>;

    const accounts = await Account.findAll({
      where: visibleAccountWhere(req),
      attributes: ['id', 'accountType'],
      raw: true,
    });
    const accountTypeById = new Map<number, string | null>();
    for (const a of accounts as unknown as Array<{ id: number; accountType: string | null }>) {
      accountTypeById.set(a.id, a.accountType);
    }

    // Group rows by (currency, merchantKey) so each top-merchant row gets
    // its own aggregator pass — reusing the same module the detail view
    // uses.
    type GroupKey = string;
    const groups = new Map<GroupKey, MerchantTimelineTxnRow[]>();
    const merchantsByKey = new Map<GroupKey, { currency: string; merchant: string }>();
    for (const row of rows) {
      const merchant = resolveMerchantKey(row);
      const key = `${row.currency} ${merchant}`;
      const list = groups.get(key) ?? [];
      list.push({ ...row, accountType: accountTypeById.get(row.accountId) ?? null });
      groups.set(key, list);
      if (!merchantsByKey.has(key)) {
        merchantsByKey.set(key, { currency: row.currency, merchant });
      }
    }

    const summaries = Array.from(groups.entries()).map(([key, rs]) => {
      const meta = merchantsByKey.get(key)!;
      const agg = aggregateMerchantTimeline(rs);
      return {
        merchant: meta.merchant,
        currency: meta.currency,
        totalSpend: agg.totals.totalSpend,
        totalCredits: agg.totals.totalCredits,
        totalIncome: agg.totals.totalIncome,
        netSpend: agg.totals.netSpend,
        transactionCount: agg.totals.transactionCount,
        averageTransaction: agg.totals.averageTransaction,
        firstDate: agg.totals.firstDate,
        lastDate: agg.totals.lastDate,
        isRecurring: agg.isRecurring,
      };
    });

    summaries.sort((a, b) => {
      if (b.netSpend !== a.netSpend) return b.netSpend - a.netSpend;
      return b.transactionCount - a.transactionCount;
    });

    res.json({ data: summaries.slice(0, limit) });
  } catch (e) {
    next(e);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Merchant-cleanup review surface (issue #793).
//
// These literal-path routes MUST be registered BEFORE the `/:name` route
// below, otherwise Express matches `GET /clusters` against `/:name` with
// name="clusters". They power the bulk merchant-cleanup UI: a derived
// cluster view plus bulk mutations on the Transaction primitive (and the
// existing Rule primitive for create-rule).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Resolve and validate the request currency. Defaults to DEFAULT_CURRENCY.
 * A supplied currency must be a known FX currency: either the default, or a
 * pair endpoint in the FxRate table (base or quote).
 */
async function resolveClusterCurrency(
  raw: unknown,
): Promise<{ ok: true; currency: string } | { ok: false }> {
  if (raw == null || raw === '') return { ok: true, currency: defaultCurrency };
  const currency = String(raw).toUpperCase().slice(0, 3);
  if (currency === defaultCurrency.toUpperCase()) return { ok: true, currency };
  const known = await FxRate.findOne({
    where: {
      [Op.or]: [{ fromCurrency: currency }, { toCurrency: currency }],
    },
    attributes: ['id'],
  });
  if (!known) return { ok: false };
  return { ok: true, currency };
}

/**
 * GET /api/merchants/clusters?currency=CAD
 *
 * One entry per distinct non-blank merchant_clean for the caller's
 * household, scoped to a single currency, sorted by total spend descending.
 */
router.get('/clusters', aiSuggestLimiter, async (req, res, next) => {
  try {
    const resolved = await resolveClusterCurrency(req.query.currency);
    if (!resolved.ok) {
      res.status(400).json({ error: 'unknown currency' });
      return;
    }
    const householdId = isSuperadmin(req) ? null : currentAuth(req).household.id;
    const clusters = await listMerchantClusters(householdId, resolved.currency);
    res.json({ clusters });
  } catch (e) {
    next(e);
  }
});

/**
 * Confirm a category name exists for the household. Categories are
 * household-scoped rows (not an enum), so a valid category is one whose
 * `name` matches an existing Category for the household.
 */
async function categoryExists(req: Request, name: string): Promise<boolean> {
  const count = await Category.count({
    where: { ...householdWhere(req), name },
  });
  return count > 0;
}

/**
 * Read a trimmed string body field, or '' when absent/non-string.
 */
function bodyString(b: Record<string, unknown>, key: string): string {
  const v = b[key];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * POST /api/merchants/bulk-recategorize
 *
 * Body: { merchantClean, category, createRule? }
 * Sets final_category on every transaction in the named cluster for the
 * household and returns the exact count changed. When createRule is true,
 * also creates a Rule whose merchantPattern derives from the cluster's
 * merchant_clean — idempotent (a second identical call returns 409). The
 * privileged mutation lives in the `bulkRecategorize` service; this handler
 * only validates input and maps the service result to an HTTP status.
 */
router.post('/bulk-recategorize', aiSuggestLimiter, async (req, res, next) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const merchantClean = bodyString(b, 'merchantClean');
    const category = bodyString(b, 'category');
    if (!merchantClean) {
      res.status(400).json({ error: 'merchantClean is required' });
      return;
    }
    if (!category) {
      res.status(400).json({ error: 'category is required' });
      return;
    }
    if (!(await categoryExists(req, category))) {
      res.status(400).json({ error: 'unknown category' });
      return;
    }

    const { household, user } = currentAuth(req);
    const result = await bulkRecategorize({
      householdId: household.id,
      createdByUserId: user.id,
      merchantClean,
      category,
      createRule: Boolean(b.createRule),
    });

    if (!result.ok) {
      if (result.reason === 'no_match') {
        res.status(404).json({ error: 'no transactions match the cluster' });
        return;
      }
      res.status(409).json({ error: 'rule already exists', ruleId: result.ruleId });
      return;
    }
    res.json({
      recategorized: result.recategorized,
      ruleCreated: result.ruleCreated,
      ruleId: result.ruleId,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/merchants/merge
 *
 * Body: {
 *   survivorMerchantClean, mergeMerchantCleans?: string[], canonicalName?
 * }
 * Reassigns the canonical (merchant_canonical) of every transaction in each
 * mergeMerchantCleans cluster to the survivor's canonical, and optionally
 * sets/overrides the survivor cluster's canonical name. A rename-only call
 * (empty merge list, canonicalName set) updates only the survivor cluster.
 * The privileged mutation lives in the `mergeMerchants` service.
 */
router.post('/merge', aiSuggestLimiter, async (req, res, next) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const survivor = bodyString(b, 'survivorMerchantClean');
    const canonicalName = bodyString(b, 'canonicalName');
    const mergeList = Array.isArray(b.mergeMerchantCleans)
      ? (b.mergeMerchantCleans as unknown[])
          .map((v) => (typeof v === 'string' ? v.trim() : ''))
          .filter((v) => v.length > 0)
      : [];

    if (!survivor) {
      res.status(400).json({ error: 'survivorMerchantClean is required' });
      return;
    }
    if (mergeList.includes(survivor)) {
      res.status(400).json({ error: 'survivor must not appear in mergeMerchantCleans' });
      return;
    }
    if (canonicalName.length > 160) {
      res.status(400).json({ error: 'canonicalName must be <= 160 chars' });
      return;
    }

    const { household } = currentAuth(req);
    const result = await mergeMerchants({
      householdId: household.id,
      survivorMerchantClean: survivor,
      mergeMerchantCleans: mergeList,
      canonicalName,
    });

    if (!result.ok) {
      const msg =
        result.reason === 'survivor_missing'
          ? 'survivor cluster has no matching transactions'
          : `cluster has no matching transactions: ${result.cluster}`;
      res.status(404).json({ error: msg });
      return;
    }
    res.json({ reassigned: result.reassigned, survivor: result.survivor });
  } catch (e) {
    next(e);
  }
});

async function loadMerchantRows(
  req: Request,
  name: string,
  currency: string | null,
): Promise<{
  rows: MerchantTimelineTxnRow[];
  receiptIds: Set<number>;
  availableCurrencies: string[];
}> {
  const baseWhere: Record<string, unknown> = {
    ...visibleTransactionWhere(req),
    ...merchantMatchWhere(name),
  };
  if (currency) baseWhere.currency = currency;

  const txns = (await Transaction.findAll({
    where: baseWhere,
    attributes: [
      'id',
      'accountId',
      'date',
      'currency',
      'finalCategory',
      'finalBusiness',
      'finalSplitType',
      'merchantRaw',
      'merchantClean',
      'merchantCanonical',
      'amount',
      'txnType',
      'isRecurring',
    ],
    raw: true,
  })) as unknown as Array<MerchantTimelineTxnRow & { accountType?: string | null }>;

  // Look up account types so non-spend classification (investment) lines up
  // with the dashboard's merchant tile.
  const accounts = await Account.findAll({
    where: visibleAccountWhere(req),
    attributes: ['id', 'accountType'],
    raw: true,
  });
  const accountTypeById = new Map<number, string | null>();
  for (const a of accounts as unknown as Array<{ id: number; accountType: string | null }>) {
    accountTypeById.set(a.id, a.accountType);
  }
  const rows: MerchantTimelineTxnRow[] = txns.map((row) => ({
    ...row,
    accountType: accountTypeById.get(row.accountId) ?? null,
  }));

  let receiptIds = new Set<number>();
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const receipts = (await Receipt.findAll({
      where: { transactionId: { [Op.in]: ids } },
      attributes: ['transactionId'],
      raw: true,
    })) as unknown as Array<{ transactionId: number }>;
    receiptIds = new Set(receipts.map((r) => r.transactionId));
  }

  // Currencies the merchant actually has rows in (independent of the
  // filter argument), so the frontend can render a currency selector.
  const availableCurrencyWhere: Record<string, unknown> = {
    ...visibleTransactionWhere(req),
    ...merchantMatchWhere(name),
  };
  const currencyRows = (await Transaction.findAll({
    where: availableCurrencyWhere,
    attributes: [[fn('DISTINCT', col('currency')), 'currency']],
    raw: true,
  })) as unknown as Array<{ currency: string }>;
  const availableCurrencies = currencyRows.map((r) => r.currency).sort();

  return { rows, receiptIds, availableCurrencies };
}

/**
 * Merchant detail. `:name` is the resolved merchant key
 * (merchantCanonical || merchantClean || merchantRaw).
 */
router.get('/:name', aiSuggestLimiter, async (req, res, next) => {
  try {
    const name = String(req.params.name ?? '').trim();
    if (!name) {
      res.status(400).json({ error: 'merchant name is required' });
      return;
    }
    const currency = parseCurrency(req.query.currency);

    const { rows, receiptIds, availableCurrencies } = await loadMerchantRows(
      req,
      name,
      currency,
    );

    const timeline = aggregateMerchantTimeline(rows, receiptIds);

    // Related rules: match the merchant against the household's rules by
    // substring on the rule's merchantPattern. We pull all
    // household-scoped rules and match in JS — match-kind 'regex' rules
    // are compiled and tested; 'substring' / 'exact' rules do plain
    // string contains/equal on the canonical merchant name.
    const rules = (await Rule.findAll({
      where: { ...householdWhere(req) },
      attributes: ['id', 'merchantPattern', 'matchKind', 'category', 'priority'],
      raw: true,
    })) as unknown as Array<{
      id: number;
      merchantPattern: string;
      matchKind: string;
      category: string | null;
      priority: number;
    }>;
    const lowerName = name.toLowerCase();
    const relatedRules = rules.filter((r) => {
      const pat = (r.merchantPattern ?? '').trim();
      if (!pat) return false;
      try {
        if (r.matchKind === 'regex') {
          return new RegExp(pat, 'i').test(name);
        }
        if (r.matchKind === 'exact') {
          return pat.toLowerCase() === lowerName;
        }
        return lowerName.includes(pat.toLowerCase());
      } catch {
        return false;
      }
    });

    res.json({
      merchant: name,
      currency: currency ?? null,
      availableCurrencies,
      ...timeline,
      relatedRules: relatedRules.map((r) => ({
        id: r.id,
        merchantPattern: r.merchantPattern,
        matchKind: r.matchKind,
        category: r.category,
        priority: r.priority,
      })),
    });
  } catch (e) {
    next(e);
  }
});

/**
 * Paginated transaction list for a merchant. Mirrors the response shape of
 * GET /api/transactions for easy client-side reuse, but with a
 * merchant-scoped where clause.
 */
router.get('/:name/transactions', aiSuggestLimiter, async (req, res, next) => {
  try {
    const name = String(req.params.name ?? '').trim();
    if (!name) {
      res.status(400).json({ error: 'merchant name is required' });
      return;
    }
    const currency = parseCurrency(req.query.currency);
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(String(req.query.pageSize || '25'), 10)),
    );
    const offset = (page - 1) * pageSize;

    const where: Record<string, unknown> = {
      ...visibleTransactionWhere(req),
      ...merchantMatchWhere(name),
    };
    if (currency) where.currency = currency;

    const { rows, count } = await Transaction.findAndCountAll({
      where,
      include: [{ model: Account, as: 'account', attributes: ['id', 'name', 'shortCode'] }],
      order: [
        ['date', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: pageSize,
      offset,
    });

    let receiptCountMap: Record<number, number> = {};
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(',');
      const cnt = (await sequelize.query<{ transactionId: number; cnt: string }>(
        `SELECT transaction_id AS "transactionId", COUNT(*) AS cnt FROM receipts WHERE transaction_id IN (${placeholders}) GROUP BY transaction_id`,
        { replacements: ids, type: QueryTypes.SELECT },
      )) as unknown as Array<{ transactionId: number; cnt: string }>;
      receiptCountMap = Object.fromEntries(
        cnt.map((r) => [r.transactionId, parseInt(String(r.cnt), 10) || 0]),
      );
    }

    res.json({
      data: rows.map((row) => ({
        ...serializeTransaction(row),
        receiptCount: receiptCountMap[row.id] ?? 0,
      })),
      page,
      pageSize,
      total: count,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
