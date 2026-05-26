/**
 * Natural-language query orchestrator.
 *
 * Pipeline:
 *   user question (string)
 *     → OpenAI JSON mode with a system prompt that constrains output
 *     → JSON envelope (untrusted)
 *     → validateIntent → typed QueryIntent
 *     → executeIntent → audited query result
 *
 * Caller (route) is responsible for OpenAI-config + demo gates BEFORE
 * invoking {@link runNaturalLanguageQuery}. The orchestrator itself only
 * raises typed errors so the route can map them to HTTP statuses cleanly.
 */
import type { Request } from 'express';
import {
  openaiJsonWithMeta,
  type OpenAiJsonResult,
} from './openaiJson.js';
import { validateIntent } from './queryIntents.js';
import { executeIntent, type ExecuteResult } from './queryBuilders.js';

const MAX_QUESTION_LEN = 500;

export type RunOptions = {
  /** Inject the current time for tests; defaults to `new Date()`. */
  today?: Date;
  /** Lets tests stub the OpenAI call without touching the real provider. */
  openaiJsonImpl?: (typeof openaiJsonWithMeta) | null;
};

export type RunResult = ExecuteResult & {
  question: string;
  meta: {
    model: string;
    promptVersion: string;
    latencyMs: number;
    providerRequestId: string | null;
  };
};

export class NlQueryError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code:
      | 'invalid_intent'
      | 'openai_error'
      | 'bad_question'
      | 'rate_limited',
  ) {
    super(message);
    this.name = 'NlQueryError';
  }
}

const PROMPT_VERSION = 'nl-query-v1';

/**
 * System prompt sent to the model. Listing the supported intents inline
 * keeps the model honest; the validator is still the security boundary.
 *
 * NOTE: Keep this string deterministic so the same question maps the same
 * way across calls (lower temperature in openaiJsonWithMeta also helps).
 */
export function buildNlSystemPrompt(today: Date): string {
  const isoToday = today.toISOString().slice(0, 10);
  return [
    `You are the Cashflow query planner. Today is ${isoToday}.`,
    `You translate a single natural-language question about the user's personal finances into ONE JSON intent envelope.`,
    `Respond with valid JSON only. Do not include prose, markdown, or code fences.`,
    ``,
    `Supported intent shapes (one of these exactly):`,
    `1. transaction_summary — totals and optional grouping`,
    `   { "intent": "transaction_summary",`,
    `     "filters": { "category"?: string, "merchant"?: string, "currency"?: string,`,
    `                  "scope"?: "personal"|"shared"|"business"|"all",`,
    `                  "business"?: boolean,`,
    `                  "dateRange"?: "this_week"|"last_week"|"this_month"|"last_month"|"this_quarter"|"last_quarter"|"this_year"|"last_year"|"all_time",`,
    `                  "dateFrom"?: "YYYY-MM-DD", "dateTo"?: "YYYY-MM-DD" },`,
    `     "groupBy"?: "category"|"merchant"|"currency"|"month"|"split" }`,
    `2. transaction_search — list matching transactions`,
    `   { "intent": "transaction_search",`,
    `     "filters": { ...same as summary, plus "missingReceipt"?: boolean } }`,
    `3. comparison — compare two periods`,
    `   { "intent": "comparison",`,
    `     "periodA": <dateRange preset>, "periodB": <dateRange preset>,`,
    `     "filters": { ...summary filters, no dateRange/dateFrom/dateTo } }`,
    `4. subscription_increase_check — find subscriptions whose price went up`,
    `   { "intent": "subscription_increase_check", "windowMonths": 1..36 }`,
    `5. partner_balance — current household settlement balances`,
    `   { "intent": "partner_balance" }`,
    ``,
    `Hard rules:`,
    `- Respond with one JSON object matching exactly one intent shape.`,
    `- Do not invent fields. If the question doesn't fit any intent, choose the closest fit; the backend will reject anything malformed.`,
    `- Prefer dateRange presets over explicit dateFrom/dateTo when the user uses words like "last month".`,
    `- Currency codes are 3 letters, ISO 4217 (CAD, USD, EUR, …).`,
  ].join('\n');
}

/**
 * Run a natural-language query end-to-end. Throws {@link NlQueryError} on
 * validation/provider failures so the route can map to HTTP cleanly.
 */
export async function runNaturalLanguageQuery(
  req: Request,
  question: string,
  opts: RunOptions = {},
): Promise<RunResult> {
  const trimmed = question?.trim();
  if (!trimmed) {
    throw new NlQueryError('question must be a non-empty string', 400, 'bad_question');
  }
  if (trimmed.length > MAX_QUESTION_LEN) {
    throw new NlQueryError(
      `question is too long (max ${MAX_QUESTION_LEN} chars)`,
      400,
      'bad_question',
    );
  }
  const today = opts.today ?? new Date();
  const systemPrompt = buildNlSystemPrompt(today);

  const openaiImpl = opts.openaiJsonImpl ?? openaiJsonWithMeta;
  let llmResult: OpenAiJsonResult;
  try {
    llmResult = await openaiImpl(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: trimmed },
      ],
      { temperature: 0 },
    );
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.status === 429) {
      throw new NlQueryError(err.message || 'rate limited', 429, 'rate_limited');
    }
    if (err.status === 503) {
      throw new NlQueryError(err.message || 'OpenAI not configured', 503, 'openai_error');
    }
    throw new NlQueryError(err.message || 'OpenAI request failed', 502, 'openai_error');
  }

  const validation = validateIntent(llmResult.json);
  if (!validation.ok) {
    throw new NlQueryError(validation.error, 400, 'invalid_intent');
  }
  const exec = await executeIntent(req, validation.intent, today);
  return {
    ...exec,
    question: trimmed,
    meta: {
      model: llmResult.model,
      promptVersion: PROMPT_VERSION,
      latencyMs: llmResult.latencyMs,
      providerRequestId: llmResult.providerRequestId,
    },
  };
}
