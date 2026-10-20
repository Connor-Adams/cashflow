/**
 * AI narrative for the "Explain this month" report. Split out of
 * routes/reports.ts so the outcome classification is unit-testable with
 * injected config/LLM deps (no network, no env juggling).
 */

import { getOpenAiConfig } from '../config/openai';
import { openaiJson } from '../ai/openaiJson';
import { logger } from '../observability/logger';
import type { ExplainMonthAiSummaryStatus, ExplainMonthResult } from './explainMonth';

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

export type ExplainMonthAiSummaryDeps = {
  getConfig: () => unknown;
  callJson: (messages: Parameters<typeof openaiJson>[0]) => Promise<Record<string, unknown>>;
};

const DEFAULT_DEPS: ExplainMonthAiSummaryDeps = {
  getConfig: getOpenAiConfig,
  callJson: openaiJson,
};

/**
 * Ask the LLM for a tight 3-5 sentence narrative of the month. The prompt
 * forces JSON output via the existing `openaiJson` helper, then we extract
 * the `summary` string. Never throws: a missing key is `not_configured`, and
 * an errored/timed-out call or an empty summary is `failed`, so the
 * deterministic report is still served and the UI can say which one it was.
 */
export async function buildExplainMonthAiSummary(
  result: ExplainMonthResult,
  deps: ExplainMonthAiSummaryDeps = DEFAULT_DEPS,
): Promise<{ aiSummary: string | null; aiSummaryStatus: ExplainMonthAiSummaryStatus }> {
  if (!deps.getConfig()) return { aiSummary: null, aiSummaryStatus: 'not_configured' };
  try {
    const response = await deps.callJson([
      {
        role: 'system',
        content:
          'You write short monthly money narratives. Take the structured month-over-month signal and findings and write a 3-5 sentence summary in plain English. Return strict JSON: { "summary": "..." }. Do not invent numbers; only refer to figures present in the input.',
      },
      {
        role: 'user',
        content: JSON.stringify(buildAiPayload(result)),
      },
    ]);
    const summary = response.summary;
    if (typeof summary === 'string' && summary.trim()) {
      return { aiSummary: summary.trim(), aiSummaryStatus: 'ok' };
    }
    logger.warn('explain_month_ai_summary_empty');
    return { aiSummary: null, aiSummaryStatus: 'failed' };
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'explain_month_ai_summary_failed',
    );
    return { aiSummary: null, aiSummaryStatus: 'failed' };
  }
}
