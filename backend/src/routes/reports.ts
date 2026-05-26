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
import { Receipt, Subscription, Transaction } from '../models';
import { currentAuth } from '../auth/middleware';
import { householdWhere, visibleTransactionWhere } from '../auth/scope';
import { aiSuggestLimiter } from './aiRateLimit';
import {
  explainMonth,
  monthBounds,
  previousMonth,
  type ExplainMonthSubRow,
  type ExplainMonthTxnRow,
  type ExplainMonthResult,
} from '../summary/explainMonth';
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
      receiptCount: (json.receipts ?? []).length,
    });
  });
}

async function fetchSubscriptions(
  req: Parameters<typeof currentAuth>[0],
  currency: string | null,
): Promise<ExplainMonthSubRow[]> {
  const where: Record<string, unknown> = { ...householdWhere(req) };
  if (currency) where.currency = currency;
  const rows = await Subscription.findAll({ where });
  return rows.map((row) => ({
    id: row.id,
    merchantName: row.merchantName,
    currency: row.currency,
    amount: Number(row.amount),
    cadence: row.cadence,
    annualizedCost: Number(row.annualizedCost),
    status: row.status,
    priceChangeDetected: Boolean(row.priceChangeDetected),
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

export default router;
