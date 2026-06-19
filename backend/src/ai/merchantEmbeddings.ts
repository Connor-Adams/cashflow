/**
 * Local, offline-capable sentence-embedding helpers for the embedding-match
 * enrichment stage (#792).
 *
 * Three responsibilities:
 *   1. `cosineSimilarity` — pure vector math, used by the stage.
 *   2. `ensureEmbedding` — read-through cache over the `merchant_embeddings`
 *      table: compute a vector once per (household, merchant_clean, model),
 *      store it, and serve it from cache on every later call. The embed
 *      function is INJECTABLE so tests run with a seeded/stubbed embedder (no
 *      model download, no network) and so callers can memoize a single model
 *      load across an import.
 *   3. `loadHouseholdMerchants` — the household's distinct, previously-reviewed
 *      merchants (the same reviewed set `merchantMemory` draws from) with their
 *      modal category/business/split and support count, to compare a cold row
 *      against.
 *
 * The default production embedder lazily loads a small local sentence model via
 * `@xenova/transformers`. That library is an OPTIONAL, operator-installed peer
 * (NOT a declared dependency) so the heavyweight ONNX runtime never burdens the
 * default install / CI; it is loaded through a runtime-computed specifier so
 * the TypeScript compiler does not try to resolve it at build time. If the
 * library or model is unavailable, `getDefaultEmbedder` returns null; the stage
 * then emits nothing and cold rows fall through to the OpenAI batch unchanged —
 * an embedding failure must never fail an import. Tests inject a stub embedder
 * and never touch this path.
 */
import { QueryTypes } from 'sequelize';
import { sequelize, MerchantEmbedding } from '../models';
import { logger } from '../observability/logger';

/** Identifier (model + pin) recorded on every cached vector so vectors from a
 *  different model are never compared or mixed. */
export const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

/** A function that turns a merchant string into a dense vector. */
export type Embedder = (text: string) => Promise<number[]>;

export type HouseholdMerchant = {
  merchantClean: string;
  category: string | null;
  business: boolean;
  splitType: string;
  pctMe: string | null;
  pctPartner: string | null;
  supportCount: number;
};

/**
 * Cosine similarity of two equal-length vectors, in [-1, 1]. Returns 0 for a
 * zero-magnitude vector or a length mismatch (which would otherwise be NaN /
 * meaningless) so the stage treats it as "not a match" rather than throwing.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function serializeVector(vec: number[]): string {
  return JSON.stringify(vec);
}

export function deserializeVector(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as number[]) : [];
  } catch {
    return [];
  }
}

/**
 * Read-through cache: return the stored vector for (household, merchant, model)
 * if present, otherwise compute it via `embed`, persist it, and return it. The
 * unique index `(household_id, merchant_clean, model)` guarantees one row per
 * key; a concurrent insert race is absorbed by re-reading on unique violation.
 */
export async function ensureEmbedding(opts: {
  householdId: number;
  merchantClean: string;
  embed: Embedder;
  model?: string;
}): Promise<number[]> {
  const model = opts.model ?? DEFAULT_EMBEDDING_MODEL;
  const existing = await MerchantEmbedding.findOne({
    where: { householdId: opts.householdId, merchantClean: opts.merchantClean, model },
  });
  if (existing) return deserializeVector(existing.embedding);

  const vec = await opts.embed(opts.merchantClean);
  try {
    await MerchantEmbedding.create({
      householdId: opts.householdId,
      merchantClean: opts.merchantClean,
      embedding: serializeVector(vec),
      dim: vec.length,
      model,
    });
  } catch (err) {
    // Lost an insert race against another row for the same unique key: re-read
    // and serve the winner's vector. Any other error is unexpected — rethrow.
    const reread = await MerchantEmbedding.findOne({
      where: { householdId: opts.householdId, merchantClean: opts.merchantClean, model },
    });
    if (reread) return deserializeVector(reread.embedding);
    throw err;
  }
  return vec;
}

type MerchantRow = {
  merchantClean: string;
  category: string | null;
  business: number | boolean;
  splitType: string;
  pctMe: string | null;
  pctPartner: string | null;
  supportCount: string | number;
};

/**
 * Distinct previously-reviewed, categorized merchants for a household, with the
 * modal category/business/split per merchant and a support count. Mirrors the
 * reviewed-transaction set `merchantMemory` reads from, but returns every
 * distinct merchant (not an exact-string lookup) so the stage can compare a
 * cold row against all of them. Strictly household-scoped.
 */
export async function loadHouseholdMerchants(
  householdId: number | null | undefined,
): Promise<HouseholdMerchant[]> {
  const rows = await sequelize.query<MerchantRow>(
    `SELECT merchant_clean AS "merchantClean",
            final_category AS category,
            final_business AS business,
            final_split_type AS "splitType",
            final_pct_me AS "pctMe",
            final_pct_partner AS "pctPartner",
            COUNT(*) AS "supportCount"
     FROM transactions
     WHERE (? IS NULL OR household_id = ?)
       AND reviewed_at IS NOT NULL
       AND final_category IS NOT NULL
       AND merchant_clean IS NOT NULL
       AND TRIM(merchant_clean) <> ''
     GROUP BY merchant_clean, final_category, final_business, final_split_type, final_pct_me, final_pct_partner
     ORDER BY merchant_clean ASC, COUNT(*) DESC`,
    { replacements: [householdId ?? null, householdId ?? null], type: QueryTypes.SELECT },
  );
  // Collapse to one row per merchant_clean — the modal (highest-support)
  // category wins, matching merchantMemory's "modal category" behavior.
  const byMerchant = new Map<string, HouseholdMerchant>();
  for (const r of rows) {
    if (byMerchant.has(r.merchantClean)) continue; // ORDER BY put the modal first
    byMerchant.set(r.merchantClean, {
      merchantClean: r.merchantClean,
      category: r.category,
      business: Boolean(r.business),
      splitType: r.splitType,
      pctMe: r.pctMe == null ? null : String(r.pctMe),
      pctPartner: r.pctPartner == null ? null : String(r.pctPartner),
      supportCount: Number(r.supportCount) || 0,
    });
  }
  return [...byMerchant.values()];
}

let defaultEmbedderPromise: Promise<Embedder | null> | null = null;

/**
 * Lazily build the default local embedder, memoized for the life of the
 * process (the model is loaded once, not per row or per import). Returns null —
 * never throws — when `@xenova/transformers` (optional dep) or its model is
 * unavailable, so the stage degrades to "no signal" and rows fall through to
 * the OpenAI batch.
 */
export async function getDefaultEmbedder(): Promise<Embedder | null> {
  if (defaultEmbedderPromise == null) {
    defaultEmbedderPromise = buildDefaultEmbedder();
  }
  return defaultEmbedderPromise;
}

type TransformersModule = {
  pipeline: (
    task: string,
    model: string,
  ) => Promise<
    (text: string, opts: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array | number[] }>
  >;
};

/** Optional-dependency module specifier, computed at runtime so the TypeScript
 *  compiler does not try to resolve `@xenova/transformers` at build time (it is
 *  an optionalDependency that may not be installed). */
const TRANSFORMERS_MODULE = ['@xenova', 'transformers'].join('/');

async function buildDefaultEmbedder(): Promise<Embedder | null> {
  try {
    const importer = new Function('m', 'return import(m);') as (m: string) => Promise<unknown>;
    const mod = (await importer(TRANSFORMERS_MODULE)) as TransformersModule;
    const extractor = await mod.pipeline('feature-extraction', DEFAULT_EMBEDDING_MODEL);
    return async (text: string): Promise<number[]> => {
      const out = await extractor(text, { pooling: 'mean', normalize: true });
      return Array.from(out.data);
    };
  } catch (err) {
    logger.warn({ err, module: 'enrichment' }, 'embedding_model_unavailable');
    return null;
  }
}
