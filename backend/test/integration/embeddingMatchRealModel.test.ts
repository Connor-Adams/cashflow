/**
 * The embedding-match stage's PRESENT path, against the real local model.
 *
 * Every other test of this stage injects a hand-crafted embedder, so until now
 * the only thing exercised with a real model was nothing at all: the model was
 * an optional, operator-installed peer that was never installed, so
 * `getDefaultEmbedder()` returned null in development, in CI and in production
 * alike, and `merchant_embeddings` had zero rows everywhere.
 *
 * This file is the counterweight. It loads the actual model through
 * `getDefaultEmbedder()`, embeds actual merchant strings, and drives a real
 * cold-row match end to end — the vector cache, the prior load, the threshold
 * comparison and the persisted `auto_*` columns and `embedding` signal.
 *
 * It lives in the integration tier, not the unit tier, for two reasons: the
 * model files are fetched from the Hugging Face hub on first use (the backend
 * image bakes them in at build time; a developer machine downloads ~23 MB once),
 * and loading the ONNX session costs a second or two. Neither belongs in a
 * hermetic, offline unit run.
 *
 * Similarity figures asserted below were measured against
 * `Xenova/all-MiniLM-L6-v2` (q8) and are asserted as ORDERING and as
 * either-side-of-threshold facts rather than exact values, so a model or
 * quantisation change surfaces as a meaningful failure rather than a rounding
 * one.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

import type { Embedder } from '../../src/ai/merchantEmbeddings.js';
import type { ColdRow } from '../../src/import/enrichment/aiBatchOverColdRows.js';

let testDb: PgTestDb;
let models: typeof import('../../src/models/index.js');
let embeddings: typeof import('../../src/ai/merchantEmbeddings.js');
let orch: typeof import('../../src/import/enrichment/embeddingMatchOverColdRows.js');
let embedder: Embedder;

before(async () => {
  testDb = await setupPgTestDb('embed_real_model');
  models = await import('../../src/models/index.js');
  embeddings = await import('../../src/ai/merchantEmbeddings.js');
  orch = await import('../../src/import/enrichment/embeddingMatchOverColdRows.js');

  const loaded = await embeddings.getDefaultEmbedder();
  assert.ok(
    loaded,
    'getDefaultEmbedder() returned null: the local embedding model is not loadable. ' +
      'This is the exact production failure this test exists to catch — the stage ' +
      'silently emits nothing when the model is missing.',
  );
  embedder = loaded;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

async function seedHousehold(): Promise<{ householdId: number; accountId: number }> {
  const hh = await models.Household.create({ name: `Embed HH ${Math.random()}` } as never);
  const acc = await models.Account.create({
    name: `Card ${Math.random()}`,
    owner: 'me',
    householdId: hh.id,
    defaultCurrency: 'CAD',
    accountType: 'credit_card',
    visibility: 'private',
  } as never);
  return { householdId: hh.id as number, accountId: acc.id as number };
}

/** A reviewed, categorised row — the prior set the stage generalises from. */
async function seedReviewedMerchant(
  householdId: number,
  accountId: number,
  merchantClean: string,
  category: string,
): Promise<void> {
  const fp = `prior-${merchantClean}-${Math.random()}`;
  await models.Transaction.create({
    accountId,
    householdId,
    visibility: 'private',
    importBatch: 'seed',
    date: '2026-05-01',
    amount: '-5.00',
    currency: 'CAD',
    merchantRaw: merchantClean,
    merchantClean,
    sourceRowFingerprint: fp,
    sourceIdentityFingerprint: fp,
    txnType: 'purchase',
    reviewFlag: false,
    finalSplitType: 'me',
    reviewedAt: new Date('2026-05-02'),
    finalCategory: category,
  } as never);
}

/** An uncategorised row with review_flag set — what the cold-row gate collects. */
async function seedColdRow(
  householdId: number,
  accountId: number,
  merchantClean: string,
): Promise<ColdRow> {
  const fp = `cold-${merchantClean}-${Math.random()}`;
  const txn = await models.Transaction.create({
    accountId,
    householdId,
    visibility: 'private',
    importBatch: 'cold',
    date: '2026-06-01',
    amount: '-12.34',
    currency: 'CAD',
    merchantRaw: merchantClean,
    merchantClean,
    sourceRowFingerprint: fp,
    sourceIdentityFingerprint: fp,
    txnType: 'purchase',
    reviewFlag: true,
    finalSplitType: 'me',
  } as never);
  return {
    txnId: txn.id as number,
    signals: [],
    merchantKey: merchantClean,
    merchantRaw: merchantClean,
    merchantClean,
    merchantCanonical: null,
    amount: -12.34,
    date: '2026-06-01',
    currency: 'CAD',
    memory: null,
    accountVisibility: 'private',
    txnType: 'purchase',
  };
}

test('the default embedder produces a real, normalized 384-dimension vector', async () => {
  const vec = await embedder('SHOPPERS DRUG MART');

  assert.equal(vec.length, 384, 'all-MiniLM-L6-v2 embeds to 384 dimensions');
  assert.ok(
    vec.every((n) => Number.isFinite(n)),
    'every component is a finite number — not NaN from a failed pooling pass',
  );
  const magnitude = Math.sqrt(vec.reduce((acc, n) => acc + n * n, 0));
  assert.ok(
    Math.abs(magnitude - 1) < 1e-3,
    `the pipeline is asked for normalize:true, so |v| should be 1, got ${magnitude}`,
  );
  // A degenerate all-zero or constant vector would pass the checks above but
  // make cosineSimilarity meaningless.
  assert.ok(new Set(vec).size > 100, 'the vector carries real variation');
});

test('real embeddings rank a lexical variant far above an unrelated merchant', async () => {
  const starbucks = await embedder('STARBUCKS');
  const starbucksCoffee = await embedder('STARBUCKS COFFEE');
  const hydro = await embedder('BC HYDRO');

  const variantSim = embeddings.cosineSimilarity(starbucks, starbucksCoffee);
  const unrelatedSim = embeddings.cosineSimilarity(starbucks, hydro);

  assert.ok(
    variantSim > unrelatedSim,
    `a variant must outrank an unrelated merchant, got ${variantSim} vs ${unrelatedSim}`,
  );
  assert.ok(
    variantSim >= 0.85,
    `"STARBUCKS COFFEE" must clear the default 0.85 threshold against "STARBUCKS", got ${variantSim}`,
  );
  assert.ok(
    unrelatedSim < 0.5,
    `an unrelated merchant must sit far below threshold, got ${unrelatedSim}`,
  );
});

test('the same embedder is memoized, so the model loads once per process', async () => {
  const again = await embeddings.getDefaultEmbedder();
  assert.equal(again, embedder, 'getDefaultEmbedder() must not reload the model per call');
});

test('a cold row is really categorised by the real model at the real default threshold', async () => {
  const { householdId, accountId } = await seedHousehold();
  await seedReviewedMerchant(householdId, accountId, 'STARBUCKS', 'Coffee');
  const cold = await seedColdRow(householdId, accountId, 'STARBUCKS COFFEE');

  // No `threshold` override: this runs on the shipped default (0.85).
  const result = await orch.maybeRunEmbeddingMatchOverColdRows([cold], householdId, {
    embedderLoader: async () => embedder,
  });

  assert.equal(result.summary.skipReason, undefined, 'the stage actually ran');
  assert.equal(result.summary.attempted, true);
  assert.equal(result.summary.matched, 1, 'the real model matched the cold row');
  assert.equal(result.remainingColdRows.length, 0, 'nothing was left for the AI batch');

  const txn = await models.Transaction.findByPk(cold.txnId);
  assert.equal(txn!.autoSource, 'embedding');
  assert.equal(txn!.autoCategory, 'Coffee');

  // Documented, and deliberately asserted rather than glossed: the real model
  // puts this pair at ~0.90, which is in the stage's MEDIUM confidence band
  // (>= 0.85 matches, >= 0.92 is high). A medium-confidence semantic guess keeps
  // `review_flag` set — the row gets a proposed category but still asks a human.
  // Only near-identical strings reach high confidence with this model, and those
  // are largely what merchant-memory already catches. That gap is the stage's
  // real-world ceiling, and it is a threshold-calibration question, not a bug
  // here.
  assert.equal(txn!.autoConfidence, 'medium');
  assert.equal(txn!.reviewFlag, true, 'a medium-confidence match still asks for review');

  const signal = await models.TransactionSignal.findOne({
    where: { transactionId: cold.txnId, source: 'embedding' },
  });
  assert.ok(signal, 'an embedding signal was persisted');
  assert.equal(signal!.confidence, 'medium');
  assert.match(
    String(signal!.rationale),
    /STARBUCKS/,
    'the rationale names the merchant it generalised from',
  );
  assert.match(
    String(signal!.rationale),
    /9\d% similar/,
    'the rationale carries the real similarity the model produced',
  );
});

test('the real run populates merchant_embeddings and serves the cache on the second pass', async () => {
  const { householdId, accountId } = await seedHousehold();
  await seedReviewedMerchant(householdId, accountId, 'STARBUCKS', 'Coffee');
  const cold = await seedColdRow(householdId, accountId, 'STARBUCKS COFFEE');

  let embedCalls = 0;
  const counting: Embedder = async (text: string) => {
    embedCalls += 1;
    return embedder(text);
  };

  await orch.maybeRunEmbeddingMatchOverColdRows([cold], householdId, {
    embedderLoader: async () => counting,
  });

  // `merchant_embeddings` had zero rows in production because the stage never
  // ran. A real run must leave the cache populated for both strings.
  const cached = await models.MerchantEmbedding.findAll({ where: { householdId } });
  assert.equal(cached.length, 2, 'the prior and the cold row were both cached');
  for (const row of cached) {
    assert.equal(row.dim, 384);
    assert.equal(
      embeddings.deserializeVector(row.embedding).length,
      384,
      'the stored vector round-trips',
    );
    assert.equal(row.model, embeddings.DEFAULT_EMBEDDING_MODEL);
  }
  assert.equal(embedCalls, 2, 'one embed per distinct string');

  // Second pass over a fresh cold row with the same merchant: the read-through
  // cache serves both vectors and the model is not invoked again.
  const second = await seedColdRow(householdId, accountId, 'STARBUCKS COFFEE');
  embedCalls = 0;
  const result = await orch.maybeRunEmbeddingMatchOverColdRows([second], householdId, {
    embedderLoader: async () => counting,
  });
  assert.equal(result.summary.matched, 1);
  assert.equal(embedCalls, 0, 'every vector came from merchant_embeddings');
});
