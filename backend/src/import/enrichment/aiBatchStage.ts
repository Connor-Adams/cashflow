/**
 * Stage 8 — ai-batch. Operates over multiple cold rows from a single import,
 * grouped by merchant identity. One OpenAI call carries all groups; on batch
 * failure, falls back to per-row calls with a concurrency cap.
 *
 * This stage is NOT invoked by enrich.ts (which is per-row). Instead, the
 * import orchestrator (runImport.ts) runs phase 1 (stages 1-7+9) per-row,
 * accumulates cold rows, then invokes runAiBatchStage once over them.
 *
 * The caller injects the OpenAI JSON caller — both to keep this module
 * testable without network and to let env/feature-flag checks live at the
 * call site.
 */
import type { Confidence } from './types';

export type AiBatchSuggestion = {
  category: string | null;
  business: boolean | null;
  splitType: 'me' | 'partner' | 'shared' | null;
  pctMe: number | null;
  pctPartner: number | null;
  confidence: Confidence;
  rationale: string | null;
};

export type AiBatchCandidate = {
  /** Unique grouping key. AI response must be keyed by this. */
  merchantKey: string;
  sampleMerchantRaw: string;
  sampleMerchantClean: string;
  sampleMerchantCanonical: string | null;
  sampleAmount: number;
  sampleDate: string;
  sampleCurrency: string;
  similarPriors: Array<{
    merchantClean: string;
    amount: number;
    date: string;
    finalCategory: string | null;
    finalBusiness: boolean;
  }>;
  memoryMatch: { category: string | null; supportCount: number } | null;
};

export type OpenAiCaller = (messages: ChatMessage[]) => Promise<Record<string, unknown>>;

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type RunAiBatchInput = {
  candidates: AiBatchCandidate[];
  categoryHints: string[];
  maxMerchants: number;
  perRowConcurrency: number;
  openaiCaller: OpenAiCaller;
};

export type RunAiBatchOutput = {
  suggestions: Map<string, AiBatchSuggestion>;
  usedBatch: boolean;
  fellBackToPerRow: boolean;
  capped: boolean;
  cappedCount: number;
};

const SYSTEM_PROMPT =
  'You categorize household card/bank transactions. Output compact JSON only. Be practical: cafes → Dining; gas stations → Transportation; grocery stores → Groceries; pharmacies → Healthcare or Groceries based on amount; software subscriptions → Subscriptions. For typical personal spending, business=false and splitType="me".';

function buildBatchPrompt(candidates: AiBatchCandidate[], categoryHints: string[]): string {
  const hints =
    categoryHints.length > 0
      ? categoryHints.join(', ')
      : '(no labels yet — invent short, reusable labels)';
  const merchantBlocks = candidates.map((c) => {
    const priors =
      c.similarPriors.length > 0
        ? c.similarPriors
            .slice(0, 5)
            .map(
              (p) =>
                `    - ${p.date} | ${p.merchantClean} | ${p.amount} | category=${p.finalCategory ?? 'null'} business=${p.finalBusiness}`,
            )
            .join('\n')
        : '    (none)';
    const mem = c.memoryMatch
      ? `category=${c.memoryMatch.category ?? 'null'} support=${c.memoryMatch.supportCount}`
      : 'none';
    return [
      `- merchant_key: "${c.merchantKey}"`,
      `  sample_merchant_raw: ${JSON.stringify(c.sampleMerchantRaw)}`,
      `  sample_merchant_clean: ${JSON.stringify(c.sampleMerchantClean)}`,
      `  sample_merchant_canonical: ${JSON.stringify(c.sampleMerchantCanonical)}`,
      `  sample_amount: ${c.sampleAmount} ${c.sampleCurrency}`,
      `  sample_date: ${c.sampleDate}`,
      `  prior_household_memory: ${mem}`,
      `  similar_priors:\n${priors}`,
    ].join('\n');
  });
  return [
    `Categorize each merchant below. One suggestion per merchant_key.`,
    ``,
    `Known category labels in this household (prefer reusing when it fits): ${hints}`,
    ``,
    `Merchants:`,
    ...merchantBlocks,
    ``,
    `Return ONLY a JSON object: { "results": { "<merchant_key>": { "category": string|null, "business": boolean, "splitType": "me"|"partner"|"shared", "pctMe": number|null, "pctPartner": number|null, "confidence": "high"|"medium"|"low", "rationale": string } } }`,
  ].join('\n');
}

function buildPerRowPrompt(c: AiBatchCandidate, categoryHints: string[]): string {
  const hints =
    categoryHints.length > 0 ? categoryHints.join(', ') : '(no labels yet — invent short labels)';
  const priors =
    c.similarPriors.length > 0
      ? c.similarPriors
          .slice(0, 5)
          .map(
            (p) =>
              `  - ${p.date} | ${p.merchantClean} | ${p.amount} | category=${p.finalCategory ?? 'null'}`,
          )
          .join('\n')
      : '  (none)';
  return [
    `Categorize one card transaction. merchant_key=${c.merchantKey}`,
    `merchant_raw: ${c.sampleMerchantRaw}`,
    `merchant_clean: ${c.sampleMerchantClean}`,
    `amount: ${c.sampleAmount} ${c.sampleCurrency}`,
    `date: ${c.sampleDate}`,
    `similar priors:\n${priors}`,
    ``,
    `Known category labels: ${hints}`,
    `Return JSON: { "category": ..., "business": ..., "splitType": ..., "pctMe": ..., "pctPartner": ..., "confidence": ..., "rationale": ... }`,
  ].join('\n');
}

const VALID_CONFIDENCE = new Set<Confidence>(['high', 'medium', 'low']);
const VALID_SPLIT = new Set<string>(['me', 'partner', 'shared']);

function coerceConfidence(v: unknown): Confidence {
  return typeof v === 'string' && VALID_CONFIDENCE.has(v as Confidence) ? (v as Confidence) : 'medium';
}

function coerceSplit(v: unknown): AiBatchSuggestion['splitType'] {
  return typeof v === 'string' && VALID_SPLIT.has(v) ? (v as AiBatchSuggestion['splitType']) : null;
}

function coerceBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function coercePct(v: unknown): number | null {
  const n = toFiniteNumber(v);
  return n == null ? null : clamp01(n);
}

function trimmedStr(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function parseSuggestion(j: Record<string, unknown> | undefined | null): AiBatchSuggestion | null {
  if (j == null || typeof j !== 'object') return null;
  return {
    category: trimmedStr(j.category),
    business: coerceBool(j.business),
    splitType: coerceSplit(j.splitType),
    pctMe: coercePct(j.pctMe),
    pctPartner: coercePct(j.pctPartner),
    confidence: coerceConfidence(j.confidence),
    rationale: trimmedStr(j.rationale),
  };
}

function collectParsedSuggestions(
  raw: Record<string, unknown>,
  candidates: AiBatchCandidate[],
): Map<string, AiBatchSuggestion> {
  const out = new Map<string, AiBatchSuggestion>();
  for (const c of candidates) {
    const sug = parseSuggestion(raw[c.merchantKey] as Record<string, unknown> | undefined);
    if (sug != null) out.set(c.merchantKey, sug);
  }
  return out;
}

function parseBatchResults(
  raw: unknown,
  candidates: AiBatchCandidate[],
): Map<string, AiBatchSuggestion> | null {
  if (raw == null || typeof raw !== 'object') return null;
  const out = collectParsedSuggestions(raw as Record<string, unknown>, candidates);
  return out.size > 0 ? out : null;
}

async function tryBatch(
  candidates: AiBatchCandidate[],
  categoryHints: string[],
  caller: OpenAiCaller,
): Promise<Map<string, AiBatchSuggestion> | null> {
  const j = await caller([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildBatchPrompt(candidates, categoryHints) },
  ]);
  return parseBatchResults((j as { results?: unknown }).results, candidates);
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

async function processLane<T, R>(
  items: T[],
  state: { next: number },
  worker: (item: T) => Promise<R>,
  results: Array<R | Error>,
): Promise<void> {
  while (state.next < items.length) {
    const i = state.next++;
    try {
      results[i] = await worker(items[i]);
    } catch (err) {
      results[i] = toError(err);
    }
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<Array<R | Error>> {
  const results: Array<R | Error> = new Array(items.length);
  const state = { next: 0 };
  const laneCount = Math.max(1, concurrency);
  const lanes = Array.from({ length: laneCount }, () => processLane(items, state, worker, results));
  await Promise.all(lanes);
  return results;
}

async function perRowFallback(
  candidates: AiBatchCandidate[],
  categoryHints: string[],
  concurrency: number,
  caller: OpenAiCaller,
): Promise<Map<string, AiBatchSuggestion>> {
  const out = new Map<string, AiBatchSuggestion>();
  const results = await runWithConcurrency(candidates, concurrency, async (c) => {
    const j = await caller([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildPerRowPrompt(c, categoryHints) },
    ]);
    return { merchantKey: c.merchantKey, suggestion: parseSuggestion(j) };
  });
  for (const r of results) {
    if (r instanceof Error) continue;
    if (r.suggestion != null) out.set(r.merchantKey, r.suggestion);
  }
  return out;
}

function applyCap<T>(items: T[], max: number): { taken: T[]; capped: boolean; cappedCount: number } {
  if (items.length <= max) return { taken: items, capped: false, cappedCount: 0 };
  return { taken: items.slice(0, max), capped: true, cappedCount: items.length - max };
}

async function safeBatch(
  candidates: AiBatchCandidate[],
  categoryHints: string[],
  caller: OpenAiCaller,
): Promise<Map<string, AiBatchSuggestion> | null> {
  try {
    return await tryBatch(candidates, categoryHints, caller);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[enrichment] ai-batch failed, falling back to per-row', toError(err).message);
    return null;
  }
}

const EMPTY_OUTPUT: RunAiBatchOutput = {
  suggestions: new Map(),
  usedBatch: false,
  fellBackToPerRow: false,
  capped: false,
  cappedCount: 0,
};

export async function runAiBatchStage(input: RunAiBatchInput): Promise<RunAiBatchOutput> {
  if (input.candidates.length === 0) return EMPTY_OUTPUT;

  const { taken: candidates, capped, cappedCount } = applyCap(input.candidates, input.maxMerchants);
  const batchOut = await safeBatch(candidates, input.categoryHints, input.openaiCaller);
  if (batchOut != null) {
    return { suggestions: batchOut, usedBatch: true, fellBackToPerRow: false, capped, cappedCount };
  }

  const perRowOut = await perRowFallback(candidates, input.categoryHints, input.perRowConcurrency, input.openaiCaller);
  return { suggestions: perRowOut, usedBatch: false, fellBackToPerRow: true, capped, cappedCount };
}
