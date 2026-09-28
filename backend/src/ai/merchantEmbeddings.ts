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
 * `@huggingface/transformers`, which IS a declared backend dependency and is
 * present in the image (see `backend/Dockerfile`, which also warms the model
 * cache at build time so the first import never waits on a download). It used to
 * be an optional, operator-installed peer that nobody installed, which is why
 * `getDefaultEmbedder` returned null everywhere and `merchant_embeddings` had
 * zero rows: the free, deterministic tier of the categorisation pipeline never
 * ran, and every cold row went straight to the paid AI batch.
 *
 * `@xenova/transformers` — the package this module originally named — is not
 * usable here. It eagerly `require`s `sharp@0.32`, whose native binary arrives
 * via a postinstall script, and `.yarnrc.yml` sets `enableScripts: false` as
 * deliberate supply-chain hardening (issue #828). Installing it therefore still
 * yields a null embedder. Its maintained successor,
 * `@huggingface/transformers`, depends on `sharp@0.35`, which ships prebuilt
 * `@img/sharp-*` platform packages and needs no install script at all. The
 * successor also carries no open advisories, where `@xenova/transformers@2.17.2`
 * (its last release) carries five, including a critical protobufjs RCE.
 *
 * It is still loaded through a runtime-computed specifier: the package is
 * ESM-only and this workspace compiles to CommonJS, so a literal `import()`
 * specifier would be downlevelled by tsc into a `require()` that cannot load an
 * ES module. `new Function('return import(m))` preserves a genuine dynamic ESM
 * import through the CJS emit. The type-only `typeof import(...)` below is
 * erased at compile time, so it costs nothing at runtime while keeping the
 * dependency statically visible to typecheck and dependency analysis.
 *
 * If the library or its model files are unavailable anyway — an image built
 * without egress, a stripped model cache — `getDefaultEmbedder` returns null;
 * the stage then emits nothing and cold rows fall through to the OpenAI batch
 * unchanged. An embedding failure must never fail an import. Tests cover that
 * path by injecting a loader that returns null (`embedderLoader`), never by
 * relying on the package being genuinely absent.
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

/**
 * The installed library's own type, referenced type-only. `typeof import(...)` is
 * erased by the compiler, so it emits no `require()` into the CommonJS output
 * while still making `@huggingface/transformers` a statically-resolved import:
 * typecheck fails if the package or its `pipeline` export goes away, instead of
 * the runtime silently degrading to a null embedder.
 */
type TransformersModule = typeof import('@huggingface/transformers');

/** Module specifier computed at runtime: the package is ESM-only and this
 *  workspace emits CommonJS, so a literal specifier would be downlevelled into
 *  a `require()` that throws ERR_REQUIRE_ESM. See the file header. */
const TRANSFORMERS_MODULE = ['@huggingface', 'transformers'].join('/');

/** 8-bit-quantized weights: ~23 MB of model files instead of the ~99 MB fp32
 *  default. `backend/Dockerfile` bakes exactly this variant into the image, so
 *  changing it changes which file is fetched and must be changed there too. */
const EMBEDDING_MODEL_DTYPE = 'q8';

async function buildDefaultEmbedder(): Promise<Embedder | null> {
  try {
    const importer = new Function('m', 'return import(m);') as (m: string) => Promise<unknown>;
    const mod = (await importer(TRANSFORMERS_MODULE)) as TransformersModule;
    const extractor = await mod.pipeline('feature-extraction', DEFAULT_EMBEDDING_MODEL, {
      dtype: EMBEDDING_MODEL_DTYPE,
    });
    return async (text: string): Promise<number[]> => {
      const out = await extractor(text, { pooling: 'mean', normalize: true });
      return Array.from(out.data);
    };
  } catch (err) {
    logger.warn({ err, module: 'enrichment' }, 'embedding_model_unavailable');
    return null;
  }
}
