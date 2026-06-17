/**
 * Sankey visualization routes (issue #224).
 *
 * Two endpoints power the /sankey page:
 *
 *   GET /api/summary/sankey
 *     Query: currency (required ISO 4217), dateFrom, dateTo, topCategories
 *     Returns: { currency, totalIncome, totalSpend, transactionCount,
 *                nodes, links, availableCurrencies, dateRange }
 *
 *     Aggregates the household's visible transactions for one currency
 *     into a recharts-friendly Sankey shape: a single "Income" source
 *     fans out to category sinks (plus a "Business spending" sink and
 *     a collapsing "Other categories" sink when the cap is exceeded).
 *
 *   GET /api/summary/sankey/source-transactions
 *     Query: source (node index), target (node index), currency, dateFrom,
 *            dateTo, topCategories
 *     Returns: { transactions: [{ id, date, currency, amount, merchant,
 *                                  category, finalBusiness, txnType }] }
 *
 *     Re-runs the aggregation, then resolves the (source, target) edge to
 *     the contributing transaction IDs, and fetches the rows so the
 *     drill-down dialog can show the user exactly which rows flowed
 *     through the clicked segment.
 *
 * Reads only — no rate limiter needed (matches the existing
 * /api/summary/dashboard, /api/partner/fairness, /api/tax/reserve/summary
 * patterns). Visibility scoping uses `visibleTransactionWhere` so the
 * non-superadmin invariant from CLAUDE.md is respected.
 */
import { Router } from 'express';
import { Op, type WhereOptions } from 'sequelize';
import { Account, Transaction } from '../models';
import { visibleAccountWhere, visibleTransactionWhere } from '../auth/scope';
import { currentAuth } from '../auth/middleware';
import { loadCategoryTree, buildRollupRows } from '../categories/rollup';
import {
  aggregateSankey,
  type SankeyTxnRow,
  DEFAULT_TOP_CATEGORIES,
} from '../summary/aggregateSankey';
import { num } from '../util/numbers';

const router = Router();

const MAX_TOP_CATEGORIES = 30;
const MIN_TOP_CATEGORIES = 3;

/**
 * Build the WhereOptions for the household's transactions for a specific
 * currency + optional date range. Currency MUST be specified — Sankey is
 * single-currency at a time (mixing currencies would distort the link
 * widths because the values share a single visual scale).
 */
function buildSankeyWhere(
  req: import('express').Request,
  currency: string,
  dateFrom: string | undefined,
  dateTo: string | undefined,
): WhereOptions {
  const w: WhereOptions = {
    ...visibleTransactionWhere(req),
    currency,
  };
  if (dateFrom || dateTo) {
    const dateCond: { [Op.gte]?: string; [Op.lte]?: string } = {};
    if (dateFrom) dateCond[Op.gte] = dateFrom;
    if (dateTo) dateCond[Op.lte] = dateTo;
    (w as { date?: unknown }).date = dateCond;
  }
  return w;
}

function parseCurrency(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const c = raw.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) return null;
  return c;
}

function parseTopCategories(raw: unknown): number {
  if (raw == null) return DEFAULT_TOP_CATEGORIES;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_TOP_CATEGORIES;
  return Math.max(MIN_TOP_CATEGORIES, Math.min(MAX_TOP_CATEGORIES, Math.floor(n)));
}

/**
 * Pulls the household's visible transaction rows + account map and runs
 * the aggregator. Returns both the aggregation result and the account
 * map so route handlers can reuse the lookup for drill-down serialization.
 */
async function loadAndAggregate(
  req: import('express').Request,
  currency: string,
  dateFrom: string | undefined,
  dateTo: string | undefined,
  topCategories: number,
): Promise<{
  result: ReturnType<typeof aggregateSankey>;
  accountTypeById: Map<number, string | null>;
}> {
  const where = buildSankeyWhere(req, currency, dateFrom, dateTo);
  const [rows, accounts] = await Promise.all([
    Transaction.findAll({
      where,
      attributes: [
        'id',
        'accountId',
        'date',
        'currency',
        'finalCategory',
        'finalCategoryId', // B2: finalCategoryId selected for rollup
        'finalBusiness',
        'merchantRaw',
        'merchantClean',
        'amount',
        'txnType',
      ],
      raw: true,
    }),
    Account.findAll({
      where: visibleAccountWhere(req),
      attributes: ['id', 'accountType'],
      raw: true,
    }),
  ]);
  type AccountRow = { id: number; accountType: string | null };
  const accountTypeById = new Map<number, string | null>(
    (accounts as unknown as AccountRow[]).map((a) => [a.id, a.accountType]),
  );

  type RawTxn = {
    id: number;
    accountId: number;
    date: string;
    currency: string;
    finalCategory: string | null;
    finalCategoryId: number | null;
    finalBusiness: boolean;
    merchantRaw: string | null;
    merchantClean: string | null;
    amount: unknown;
    txnType: string | null;
  };
  const sankeyRows: SankeyTxnRow[] = (rows as unknown as RawTxn[]).map((r) => ({
    id: r.id,
    date: r.date,
    currency: r.currency,
    finalCategory: r.finalCategory,
    finalCategoryId: r.finalCategoryId ?? null,
    finalBusiness: r.finalBusiness,
    merchantRaw: r.merchantRaw,
    merchantClean: r.merchantClean,
    amount: r.amount,
    txnType: r.txnType,
    accountType: accountTypeById.get(r.accountId) ?? null,
  }));

  const result = aggregateSankey(sankeyRows, currency, { topCategories });
  return { result, accountTypeById };
}

/**
 * Returns the list of currencies the household has any visible txn in.
 * Used to populate the currency picker on the page so it never offers a
 * currency that has zero rows.
 */
async function loadAvailableCurrencies(
  req: import('express').Request,
): Promise<string[]> {
  const rows = await Transaction.findAll({
    where: visibleTransactionWhere(req),
    attributes: ['currency'],
    group: ['currency'],
    raw: true,
  });
  return (rows as unknown as Array<{ currency: string }>)
    .map((r) => r.currency)
    .filter((c) => typeof c === 'string' && c.length === 3)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * GET /api/summary/sankey
 *
 * Sankey aggregation for one currency + optional date range. Currency is
 * required; the page knows the available list via `availableCurrencies`
 * in the response (also returned when the request omits currency — the
 * page can then pick a sensible default and re-request).
 */
router.get('/', async (req, res, next) => {
  try {
    const currency = parseCurrency(req.query.currency);
    const dateFrom =
      typeof req.query.dateFrom === 'string' ? req.query.dateFrom : undefined;
    const dateTo =
      typeof req.query.dateTo === 'string' ? req.query.dateTo : undefined;
    const topCategories = parseTopCategories(req.query.topCategories);

    const availableCurrencies = await loadAvailableCurrencies(req);
    if (!currency) {
      // No currency yet — the page renders an empty state. We surface the
      // available list so the picker can populate even before the first
      // aggregation runs.
      res.json({
        currency: null,
        totalIncome: 0,
        totalSpend: 0,
        transactionCount: 0,
        nodes: [],
        links: [],
        availableCurrencies,
        dateRange: { from: dateFrom ?? null, to: dateTo ?? null },
      });
      return;
    }

    const { result } = await loadAndAggregate(
      req,
      currency,
      dateFrom,
      dateTo,
      topCategories,
    );

    // Build a raw spend map from sankey category nodes for the rollup.
    // Each link.target points to a node; use node.categoryId and link.value.
    const sankeyRaw = new Map<number, number>();
    for (const link of result.links) {
      const node = result.nodes[link.target];
      if (node?.categoryId != null) {
        sankeyRaw.set(node.categoryId, (sankeyRaw.get(node.categoryId) ?? 0) + link.value);
      }
    }
    const householdId = currentAuth(req).household.id;
    const categoryTree = buildRollupRows(sankeyRaw, await loadCategoryTree(householdId));

    res.json({
      currency: result.currency,
      totalIncome: result.totalIncome,
      totalSpend: result.totalSpend,
      transactionCount: result.transactionCount,
      // Pass nodes + links through unchanged; the client passes them
      // directly to <Sankey data={...} />.
      nodes: result.nodes,
      links: result.links,
      availableCurrencies,
      dateRange: { from: dateFrom ?? null, to: dateTo ?? null },
      categoryTree,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/summary/sankey/source-transactions
 *
 * Drill-down: given a (source, target) link the user clicked in the
 * frontend, return the transaction rows that flowed through it.
 *
 * The aggregation is replayed server-side because (a) the client doesn't
 * carry transaction IDs in the chart payload, and (b) the edge → IDs
 * lookup is cheap once the rows are in memory. Cap the returned row
 * count to avoid pathologically large responses; the dialog uses the
 * cap value to surface a "truncated" hint.
 */
const MAX_DRILLDOWN_ROWS = 500;

router.get('/source-transactions', async (req, res, next) => {
  try {
    const currency = parseCurrency(req.query.currency);
    if (!currency) {
      res.status(400).json({ error: 'currency required' });
      return;
    }
    const sourceRaw = req.query.source;
    const targetRaw = req.query.target;
    const source = Number(sourceRaw);
    const target = Number(targetRaw);
    if (!Number.isInteger(source) || source < 0) {
      res.status(400).json({ error: 'source must be a non-negative integer' });
      return;
    }
    if (!Number.isInteger(target) || target < 0) {
      res.status(400).json({ error: 'target must be a non-negative integer' });
      return;
    }
    const dateFrom =
      typeof req.query.dateFrom === 'string' ? req.query.dateFrom : undefined;
    const dateTo =
      typeof req.query.dateTo === 'string' ? req.query.dateTo : undefined;
    const topCategories = parseTopCategories(req.query.topCategories);

    const { result } = await loadAndAggregate(
      req,
      currency,
      dateFrom,
      dateTo,
      topCategories,
    );
    const ids = result.edgeMap.get(`${source}-${target}`);
    if (!ids || ids.length === 0) {
      res.json({
        edge: { source, target },
        transactionCount: 0,
        truncated: false,
        transactions: [],
      });
      return;
    }

    const limited = ids.slice(0, MAX_DRILLDOWN_ROWS);
    // Fetch only the rows the user is allowed to see; the IDs came from
    // an aggregation that already applied visibleTransactionWhere, but
    // we re-apply the filter as belt-and-suspenders in case the IDs
    // race a permission change.
    const rows = await Transaction.findAll({
      where: {
        ...visibleTransactionWhere(req),
        id: { [Op.in]: limited },
      },
      attributes: [
        'id',
        'date',
        'currency',
        'amount',
        'merchantRaw',
        'merchantClean',
        'merchantCanonical',
        'finalCategory',
        'finalBusiness',
        'txnType',
      ],
      order: [
        ['date', 'DESC'],
        ['id', 'DESC'],
      ],
      raw: true,
    });
    type RawTxn = {
      id: number;
      date: string;
      currency: string;
      amount: unknown;
      merchantRaw: string | null;
      merchantClean: string | null;
      merchantCanonical: string | null;
      finalCategory: string | null;
      finalBusiness: boolean;
      txnType: string | null;
    };
    const serialised = (rows as unknown as RawTxn[]).map((r) => ({
      id: r.id,
      date: r.date,
      currency: r.currency,
      amount: num(r.amount) ?? 0,
      merchant:
        r.merchantCanonical?.trim() ||
        r.merchantClean?.trim() ||
        r.merchantRaw?.trim() ||
        '(unknown merchant)',
      finalCategory: r.finalCategory,
      finalBusiness: r.finalBusiness,
      txnType: r.txnType,
    }));
    res.json({
      edge: { source, target },
      transactionCount: ids.length,
      truncated: ids.length > MAX_DRILLDOWN_ROWS,
      transactions: serialised,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
