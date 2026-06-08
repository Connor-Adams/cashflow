/**
 * Reports routes (Cashflow #225).
 *
 * Currently exposes the "Explain this month" report which builds a
 * deterministic month-over-month narrative from existing data:
 * transactions, subscriptions, receipts. A free-form natural-language
 * summary can be requested via `?ai=true` — when OpenAI is configured the
 * route calls openaiJson() with the deterministic findings as context and
 * stores the returned summary on the response; when not, the route returns
 * `aiSummary: null` so the UI degrades gracefully.
 *
 * The route is mounted at /api/reports; the rate limiter (aiSuggestLimiter)
 * is applied across the board because the AI variant is the more expensive
 * path and we don't want to litter the route handler with branching
 * limiters. The deterministic case is cheap so the limiter ceiling never
 * binds in practice.
 */

import { Router } from 'express';
import { Op } from 'sequelize';
import type { WhereOptions } from 'sequelize';
import { Account, Insight, PlannedEvent, Receipt, Transaction } from '../models';
import { serializeSubscription } from '../expectations/subscriptionMapper';
import { currentAuth } from '../auth/middleware';
import { householdWhere, visibleAccountWhere, visibleTransactionWhere } from '../auth/scope';
import { aiSuggestLimiter } from './aiRateLimit';
import {
  explainMonth,
  monthBounds,
  previousMonth,
  type ExplainMonthSubRow,
  type ExplainMonthTxnRow,
  type ExplainMonthResult,
} from '../summary/explainMonth';
import {
  buildMonthWindow,
  lifestyleInflation,
  type LifestyleInflationTxnRow,
} from '../summary/lifestyleInflation';
import {
  savingsRate,
  type SavingsRateTxnRow,
} from '../summary/savingsRate';
import { scopeWhereClause } from './budgets';
import { getOpenAiConfig } from '../config/openai';
import { openaiJson } from '../ai/openaiJson';
import { logger } from '../observability/logger';

const router = Router();

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function parseMonth(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (!MONTH_RE.test(raw)) return null;
  return raw;
}

function parseCurrency(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(s)) return null;
  return s;
}

function parseBool(raw: unknown): boolean {
  if (raw == null) return false;
  const s = String(raw).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

/**
 * Scope filter for the lifestyle-inflation report. The issue frames scopes as
 * "personal, shared, business, and all"; we map those to the existing budget
 * scope WHERE clauses so the two features classify spend identically:
 *
 *   personal → private + non-business     (scopeWhereClause('personal'))
 *   shared   → visibility = 'shared'       (scopeWhereClause('household'))
 *   business → final_business = true       (scopeWhereClause('business'))
 *   all      → no extra filter ({})
 *
 * Unknown/missing scope falls open to 'all'. The returned clause is combined
 * with visibleTransactionWhere() so row-level visibility is always enforced.
 */
const LIFESTYLE_SCOPES = ['personal', 'shared', 'business', 'all'] as const;
type LifestyleScope = (typeof LIFESTYLE_SCOPES)[number];

function parseScope(raw: unknown): LifestyleScope {
  if (raw == null || raw === '') return 'all';
  const s = String(raw).trim().toLowerCase();
  return (LIFESTYLE_SCOPES as readonly string[]).includes(s)
    ? (s as LifestyleScope)
    : 'all';
}

function scopeFilter(scope: LifestyleScope): WhereOptions {
  switch (scope) {
    case 'personal':
      return scopeWhereClause('personal');
    case 'shared':
      return scopeWhereClause('household');
    case 'business':
      return scopeWhereClause('business');
    case 'all':
    default:
      return {};
  }
}

const DEFAULT_LIFESTYLE_WINDOW_MONTHS = 12;
const MIN_LIFESTYLE_WINDOW_MONTHS = 2;
const MAX_LIFESTYLE_WINDOW_MONTHS = 36;

/** Clamp the requested window size into a sane range. Defaults to 12. */
function parseWindowMonths(raw: unknown): number {
  if (raw == null || raw === '') return DEFAULT_LIFESTYLE_WINDOW_MONTHS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIFESTYLE_WINDOW_MONTHS;
  return Math.min(
    MAX_LIFESTYLE_WINDOW_MONTHS,
    Math.max(MIN_LIFESTYLE_WINDOW_MONTHS, Math.trunc(n)),
  );
}

/** Current calendar month (YYYY-MM) in UTC — used as the default anchor. */
function currentMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

interface TxnRawRow {
  id: number;
  date: string;
  currency: string;
  amount: unknown;
  finalCategory: string | null;
  finalBusiness: boolean;
  merchantClean: string | null;
  merchantRaw: string | null;
  reviewFlag: boolean;
  receiptCount: string | number | null;
  txnType: string | null;
}

function rowToTxn(row: TxnRawRow): ExplainMonthTxnRow {
  const rc = row.receiptCount;
  const count = typeof rc === 'number' ? rc : rc == null ? 0 : Number(rc);
  return {
    id: row.id,
    date: row.date,
    currency: row.currency,
    amount: row.amount,
    finalCategory: row.finalCategory,
    finalBusiness: Boolean(row.finalBusiness),
    merchantClean: row.merchantClean,
    merchantRaw: row.merchantRaw,
    reviewFlag: Boolean(row.reviewFlag),
    receiptCount: Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0,
    txnType: row.txnType ?? null,
  };
}

async function fetchTransactionsWithReceipts(
  req: Parameters<typeof currentAuth>[0],
  fromDate: string,
  toDate: string,
  currency: string | null,
): Promise<ExplainMonthTxnRow[]> {
  const where: Record<string, unknown> = {
    ...visibleTransactionWhere(req),
    date: { [Op.between]: [fromDate, toDate] },
  };
  if (currency) where.currency = currency;
  const rows = await Transaction.findAll({
    where,
    attributes: [
      'id',
      'date',
      'currency',
      'amount',
      'finalCategory',
      'finalBusiness',
      'merchantClean',
      'merchantRaw',
      'reviewFlag',
      'txnType',
    ],
    include: [
      {
        model: Receipt,
        as: 'receipts',
        attributes: ['id'],
        required: false,
      },
    ],
  });
  type TxnWithReceipts = {
    id: number;
    date: string;
    currency: string;
    amount: unknown;
    finalCategory: string | null;
    finalBusiness: boolean;
    merchantClean: string | null;
    merchantRaw: string | null;
    reviewFlag: boolean;
    txnType: string | null;
    receipts?: Array<{ id: number }>;
  };
  return rows.map((r) => {
    const json = r.toJSON() as TxnWithReceipts;
    return rowToTxn({
      id: json.id,
      date: json.date,
      currency: json.currency,
      amount: json.amount,
      finalCategory: json.finalCategory,
      finalBusiness: json.finalBusiness,
      merchantClean: json.merchantClean,
      merchantRaw: json.merchantRaw,
      reviewFlag: json.reviewFlag,
      txnType: json.txnType,
      receiptCount: (json.receipts ?? []).length,
    });
  });
}

async function fetchSubscriptions(
  req: Parameters<typeof currentAuth>[0],
  currency: string | null,
): Promise<ExplainMonthSubRow[]> {
  // Subscriptions are folded into planned_events as kind='subscription'
  // (Expectation merge). serializeSubscription maps a merged row back to the
  // legacy Subscription DTO this report expects.
  const where: Record<string, unknown> = { ...householdWhere(req), kind: 'subscription' };
  if (currency) where.currency = currency;
  const rows = await PlannedEvent.findAll({ where });
  // The price-increase signal now lives in an open Insight
  // (type='subscription_price_increase', entityId=PlannedEvent.id), not the
  // retired planned_events.price_change_detected column (serializeSubscription
  // hard-codes that field to false). Build the set of subscriptions with an
  // OPEN price-increase Insight so explainMonth's "price changed" finding still
  // fires; dismissing/resolving the Insight clears it on the next read. Mirrors
  // routes/moneyLeaks.ts.
  const priceInsights = await Insight.findAll({
    where: {
      ...householdWhere(req),
      type: 'subscription_price_increase',
      status: 'open',
    },
    attributes: ['entityId'],
    raw: true,
  });
  const priceUp = new Set<number>(
    priceInsights.map((i) => i.entityId).filter((x): x is number => x != null),
  );
  return rows.map(serializeSubscription).map((row) => ({
    id: row.id,
    merchantName: row.merchantName,
    currency: row.currency,
    amount: Number(row.amount),
    cadence: row.cadence,
    annualizedCost: Number(row.annualizedCost),
    status: row.status,
    priceChangeDetected: priceUp.has(row.id),
    category: row.category,
    lastChargeDate: row.lastChargeDate,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/**
 * Build a short JSON payload representing the report findings + monthOverMonth
 * deltas for the AI summarizer. We strip ids and verbose meta to keep the
 * prompt short — the AI sees the structured signal, not the raw txn rows.
 */
function buildAiPayload(result: ExplainMonthResult): Record<string, unknown> {
  return {
    month: result.month,
    previousMonth: result.previousMonth,
    monthOverMonth: result.monthOverMonth.map((m) => ({
      currency: m.currency,
      currentSpend: Number(m.currentSpend.toFixed(2)),
      previousSpend: Number(m.previousSpend.toFixed(2)),
      spendDelta: Number(m.spendDelta.toFixed(2)),
      currentIncome: Number(m.currentIncome.toFixed(2)),
      previousIncome: Number(m.previousIncome.toFixed(2)),
      netCurrent: Number(m.netCurrent.toFixed(2)),
      netPrevious: Number(m.netPrevious.toFixed(2)),
      topCategoryMovers: m.byCategory
        .filter((c) => Math.abs(c.delta) >= 1)
        .slice(0, 5)
        .map((c) => ({
          category: c.category,
          previous: Number(c.previous.toFixed(2)),
          current: Number(c.current.toFixed(2)),
          delta: Number(c.delta.toFixed(2)),
        })),
    })),
    findings: result.findings.map((f) => ({
      kind: f.kind,
      title: f.title,
      summary: f.summary,
      currency: f.currency,
      monthlyImpact: Number(f.monthlyImpact.toFixed(2)),
      severity: f.severity,
    })),
  };
}

/**
 * Ask the LLM for a tight 3-5 sentence narrative of the month. The prompt
 * forces JSON output via the existing `openaiJson` helper, then we extract
 * the `summary` string. Failures and missing keys degrade gracefully.
 */
async function maybeBuildAiSummary(
  result: ExplainMonthResult,
): Promise<string | null> {
  const cfg = getOpenAiConfig();
  if (!cfg) return null;
  try {
    const payload = buildAiPayload(result);
    const response = await openaiJson([
      {
        role: 'system',
        content:
          'You write short monthly money narratives. Take the structured month-over-month signal and findings and write a 3-5 sentence summary in plain English. Return strict JSON: { "summary": "..." }. Do not invent numbers; only refer to figures present in the input.',
      },
      {
        role: 'user',
        content: JSON.stringify(payload),
      },
    ]);
    const summary = response.summary;
    return typeof summary === 'string' && summary.trim() ? summary.trim() : null;
  } catch (e) {
    // Degrade gracefully: log it but return null so the deterministic report
    // is still served.
    logger.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'explain_month_ai_summary_failed',
    );
    return null;
  }
}

router.get('/explain-month', aiSuggestLimiter, async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    void auth; // currentAuth() throws if unauthenticated — keep the call for safety.

    const month = parseMonth(req.query.month);
    if (!month) {
      res.status(400).json({
        error: 'month must be in YYYY-MM format (e.g. 2026-05)',
      });
      return;
    }
    const currency = parseCurrency(req.query.currency);
    const includeAi = parseBool(req.query.ai);

    const prev = previousMonth(month);
    const curBounds = monthBounds(month);
    const prevBounds = monthBounds(prev);

    const [currentTxns, previousTxns, subscriptions] = await Promise.all([
      fetchTransactionsWithReceipts(req, curBounds.from, curBounds.to, currency),
      fetchTransactionsWithReceipts(req, prevBounds.from, prevBounds.to, currency),
      fetchSubscriptions(req, currency),
    ]);

    const result = explainMonth({
      month,
      currentTxns,
      previousTxns,
      subscriptions,
      currency,
    });

    if (includeAi) {
      result.aiSummary = await maybeBuildAiSummary(result);
    }

    res.json(result);
  } catch (e) {
    next(e);
  }
});

/**
 * Fetch transactions across the whole window for the lifestyle-inflation
 * report. Joins account_type (via a per-household account-type map) so the
 * aggregator can drop investment-account rows, mirroring /summary/monthly.
 */
async function fetchLifestyleTransactions(
  req: Parameters<typeof currentAuth>[0],
  fromDate: string,
  toDate: string,
  currency: string | null,
  scope: LifestyleScope,
): Promise<LifestyleInflationTxnRow[]> {
  const where: WhereOptions = {
    ...visibleTransactionWhere(req),
    ...scopeFilter(scope),
    date: { [Op.between]: [fromDate, toDate] },
  };
  if (currency) (where as Record<string, unknown>).currency = currency;

  const [rows, accounts] = await Promise.all([
    Transaction.findAll({
      where,
      attributes: ['accountId', 'date', 'currency', 'amount', 'finalCategory', 'txnType'],
      raw: true,
    }),
    Account.findAll({
      where: visibleAccountWhere(req),
      attributes: ['id', 'accountType'],
      raw: true,
    }),
  ]);

  const accountTypeById = new Map<number, string | null>(
    (accounts as unknown as Array<{ id: number; accountType: string | null }>).map((a) => [
      a.id,
      a.accountType,
    ]),
  );

  type RawRow = {
    accountId: number;
    date: string;
    currency: string;
    amount: unknown;
    finalCategory: string | null;
    txnType: string | null;
  };
  return (rows as unknown as RawRow[]).map((r) => ({
    date: r.date,
    currency: r.currency,
    amount: r.amount,
    finalCategory: r.finalCategory,
    txnType: r.txnType,
    accountType: accountTypeById.get(r.accountId) ?? null,
  }));
}

/**
 * GET /api/reports/lifestyle-inflation (Cashflow #245).
 *
 * Tracks whether spending growth is outpacing income growth over a rolling
 * window of months. Returns, per currency: a monthly income/spend/savings
 * series, first-half-vs-second-half growth figures, the categories driving
 * spend growth, and a warning insight when spend growth materially outpaces
 * income growth.
 *
 * Query params:
 *   month     — anchor month YYYY-MM (default: current month). The window ends here.
 *   months    — window size, clamped to [2, 36] (default 12).
 *   currency  — 3-letter filter, or omit for all currencies.
 *   scope     — personal | shared | business | all (default all).
 *   threshold — percentage-point gap for the outpacing insight (default 10).
 */
router.get('/lifestyle-inflation', async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    void auth; // throws if unauthenticated.

    const anchor =
      req.query.month != null && req.query.month !== ''
        ? parseMonth(req.query.month)
        : currentMonth();
    if (!anchor) {
      res.status(400).json({
        error: 'month must be in YYYY-MM format (e.g. 2026-05)',
      });
      return;
    }
    const windowMonths = parseWindowMonths(req.query.months);
    const currency = parseCurrency(req.query.currency);
    const scope = parseScope(req.query.scope);
    const thresholdRaw = Number(req.query.threshold);
    const outpaceThresholdPct =
      Number.isFinite(thresholdRaw) && thresholdRaw >= 0 ? thresholdRaw : undefined;

    const months = buildMonthWindow(anchor, windowMonths);
    const fromDate = monthBounds(months[0]).from;
    const toDate = monthBounds(months[months.length - 1]).to;

    const transactions = await fetchLifestyleTransactions(
      req,
      fromDate,
      toDate,
      currency,
      scope,
    );

    const result = lifestyleInflation({
      months,
      transactions,
      currency,
      outpaceThresholdPct,
    });

    res.json({
      anchorMonth: anchor,
      scope,
      currency: currency ?? null,
      ...result,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * Fetch transactions across the whole window for the savings-rate report.
 * Joins each row's account_type (via a per-household account-type map) so the
 * aggregator can tell a deposit into a savings account from spend on a card.
 */
async function fetchSavingsRateTransactions(
  req: Parameters<typeof currentAuth>[0],
  fromDate: string,
  toDate: string,
  currency: string | null,
  scope: LifestyleScope,
): Promise<SavingsRateTxnRow[]> {
  const where: WhereOptions = {
    ...visibleTransactionWhere(req),
    ...scopeFilter(scope),
    date: { [Op.between]: [fromDate, toDate] },
  };
  if (currency) (where as Record<string, unknown>).currency = currency;

  const [rows, accounts] = await Promise.all([
    Transaction.findAll({
      where,
      attributes: ['accountId', 'date', 'currency', 'amount', 'txnType', 'transferPurpose'],
      raw: true,
    }),
    Account.findAll({
      where: visibleAccountWhere(req),
      attributes: ['id', 'accountType'],
      raw: true,
    }),
  ]);

  const accountTypeById = new Map<number, string | null>(
    (accounts as unknown as Array<{ id: number; accountType: string | null }>).map((a) => [
      a.id,
      a.accountType,
    ]),
  );

  type RawRow = {
    accountId: number;
    date: string;
    currency: string;
    amount: unknown;
    txnType: string | null;
    transferPurpose: string | null;
  };
  return (rows as unknown as RawRow[]).map((r) => ({
    date: r.date,
    currency: r.currency,
    amount: r.amount,
    txnType: r.txnType,
    transferPurpose: r.transferPurpose,
    accountType: accountTypeById.get(r.accountId) ?? null,
  }));
}

/**
 * GET /api/reports/savings-rate (Cashflow #246).
 *
 * Tracks the user's "true" savings rate over a rolling window of months: of
 * the income that came in, what fraction was kept as cash savings, investment
 * contributions, and debt-principal paydown rather than spent. Returns, per
 * currency: a monthly income / spending / savings / investments / debt-
 * principal series with a per-month savings-rate percentage, plus window
 * totals and an overall savings rate.
 *
 * Query params:
 *   month                — anchor month YYYY-MM (default: current month). The window ends here.
 *   months               — window size, clamped to [2, 36] (default 12).
 *   currency             — 3-letter filter, or omit for all currencies.
 *   scope                — personal | shared | business | all (default all).
 *   includeInvestments   — count investment contributions toward the rate (default true).
 *   includeDebtPrincipal — count debt-principal paydown toward the rate (default true).
 */
router.get('/savings-rate', async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    void auth; // throws if unauthenticated.

    const anchor =
      req.query.month != null && req.query.month !== ''
        ? parseMonth(req.query.month)
        : currentMonth();
    if (!anchor) {
      res.status(400).json({
        error: 'month must be in YYYY-MM format (e.g. 2026-05)',
      });
      return;
    }
    const windowMonths = parseWindowMonths(req.query.months);
    const currency = parseCurrency(req.query.currency);
    const scope = parseScope(req.query.scope);
    // Both inclusions default to true; an explicitly-present flag set to a
    // falsey value (false/0/no/off) turns it off.
    const includeInvestments =
      req.query.includeInvestments == null ? true : parseBool(req.query.includeInvestments);
    const includeDebtPrincipal =
      req.query.includeDebtPrincipal == null ? true : parseBool(req.query.includeDebtPrincipal);

    const months = buildMonthWindow(anchor, windowMonths);
    const fromDate = monthBounds(months[0]).from;
    const toDate = monthBounds(months[months.length - 1]).to;

    const transactions = await fetchSavingsRateTransactions(
      req,
      fromDate,
      toDate,
      currency,
      scope,
    );

    const result = savingsRate({
      months,
      transactions,
      currency,
      includeInvestments,
      includeDebtPrincipal,
    });

    res.json({
      anchorMonth: anchor,
      scope,
      currency: currency ?? null,
      ...result,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
