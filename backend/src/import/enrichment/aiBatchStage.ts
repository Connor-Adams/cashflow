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

function coerceConfidence(v: unknown): Confidence {
  return v === 'high' || v === 'medium' || v === 'low' ? v : 'medium';
}

function coerceSplit(v: unknown): AiBatchSuggestion['splitType'] {
  return v === 'me' || v === 'partner' || v === 'shared' ? v : null;
}

function coerceBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

function coercePct(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.min(1, v));
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
  }
  return null;
}

function parseSuggestion(j: Record<string, unknown> | undefined | null): AiBatchSuggestion | null {
  if (j == null || typeof j !== 'object') return null;
  const category = typeof j.category === 'string' && j.category.trim() ? j.category.trim() : null;
  return {
    category,
    business: coerceBool(j.business),
    splitType: coerceSplit(j.splitType),
    pctMe: coercePct(j.pctMe),
    pctPartner: coercePct(j.pctPartner),
    confidence: coerceConfidence(j.confidence),
    rationale: typeof j.rationale === 'string' && j.rationale.trim() ? j.rationale.trim() : null,
  };
}

async function tryBatch(
  candidates: AiBatchCandidate[],
  categoryHints: string[],
  caller: OpenAiCaller,
): Promise<Map<string, AiBatchSuggestion> | null> {
  const prompt = buildBatchPrompt(candidates, categoryHints);
  const j = await caller([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ]);
  const results = (j as { results?: unknown }).results;
  if (results == null || typeof results !== 'object') return null;
  const out = new Map<string, AiBatchSuggestion>();
  for (const c of candidates) {
    const entry = (results as Record<string, unknown>)[c.merchantKey];
    const sug = parseSuggestion(entry as Record<string, unknown> | undefined);
    if (sug != null) out.set(c.merchantKey, sug);
  }
  // If we got zero parsed suggestions, treat as failure so we fall back.
  if (out.size === 0) return null;
  return out;
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<Array<R | Error>> {
  const results: Array<R | Error> = new Array(items.length);
  let nextIndex = 0;
  const lanes = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i]);
      } catch (err) {
        results[i] = err instanceof Error ? err : new Error(String(err));
      }
    }
  });
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

export async function runAiBatchStage(input: RunAiBatchInput): Promise<RunAiBatchOutput> {
  const { candidates: all, categoryHints, maxMerchants, perRowConcurrency, openaiCaller } = input;

  if (all.length === 0) {
    return { suggestions: new Map(), usedBatch: false, fellBackToPerRow: false, capped: false, cappedCount: 0 };
  }

  const capped = all.length > maxMerchants;
  const candidates = capped ? all.slice(0, maxMerchants) : all;
  const cappedCount = capped ? all.length - candidates.length : 0;

  let batchOut: Map<string, AiBatchSuggestion> | null = null;
  try {
    batchOut = await tryBatch(candidates, categoryHints, openaiCaller);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[enrichment] ai-batch failed, falling back to per-row', err instanceof Error ? err.message : err);
    batchOut = null;
  }

  if (batchOut != null) {
    return {
      suggestions: batchOut,
      usedBatch: true,
      fellBackToPerRow: false,
      capped,
      cappedCount,
    };
  }

  const perRowOut = await perRowFallback(candidates, categoryHints, perRowConcurrency, openaiCaller);
  return {
    suggestions: perRowOut,
    usedBatch: false,
    fellBackToPerRow: true,
    capped,
    cappedCount,
  };
}
