import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.ENRICHMENT_EMBEDDING_ENABLED = 'true';

let models: typeof import('../../models');
let sequelize: import('sequelize').Sequelize;
let orch: typeof import('./embeddingMatchOverColdRows');
let Embedder: typeof import('../../ai/merchantEmbeddings').Embedder;

before(async () => {
  models = await import('../../models');
  sequelize = models.sequelize;
  orch = await import('./embeddingMatchOverColdRows');
  await sequelize.sync({ force: true });
});
after(async () => { await sequelize.close(); });
beforeEach(async () => {
  await models.TransactionSignal.destroy({ where: {}, truncate: true });
  await models.MerchantEmbedding.destroy({ where: {}, truncate: true });
  await models.Transaction.destroy({ where: {}, truncate: true });
  await models.Account.destroy({ where: {}, truncate: true });
  await models.Household.destroy({ where: {}, truncate: true });
});

// A toy embedder: maps known merchants to hand-crafted unit vectors so cosine
// similarity is deterministic. Unknown strings get an orthogonal vector.
const VECTORS: Record<string, number[]> = {
  'Blue Bottle Coffee': [1, 0, 0],
  'SQ *BLUE BOTTLE': [0.96, Math.sqrt(1 - 0.96 * 0.96), 0], // ~0.96 cos with Blue Bottle
  'Whole Foods': [0, 1, 0],
  'Totally Unrelated XYZ': [0, 0, 1], // orthogonal to everything seeded
};
const toyEmbedder: typeof Embedder = async (text: string) => VECTORS[text] ?? [0, 0, 0.0001];

async function seedReviewedMerchant(householdId: number, accountId: number, merchantClean: string, category: string) {
  const fp = `seed-${Math.random()}`;
  await models.Transaction.create({
    accountId, householdId, visibility: 'private', importBatch: 'seed',
    date: '2026-05-01', amount: '-5.00', currency: 'CAD',
    merchantRaw: merchantClean, merchantClean,
    sourceRowFingerprint: fp, sourceIdentityFingerprint: fp,
    txnType: 'purchase', reviewFlag: false, finalSplitType: 'me',
    reviewedAt: new Date('2026-05-02'), finalCategory: category,
  } as never);
}

async function coldTxn(householdId: number, accountId: number, merchantClean: string) {
  const fp = `cold-${Math.random()}`;
  const txn = await models.Transaction.create({
    accountId, householdId, visibility: 'private', importBatch: 'import',
    date: '2026-06-01', amount: '-7.00', currency: 'CAD',
    merchantRaw: merchantClean, merchantClean,
    sourceRowFingerprint: fp, sourceIdentityFingerprint: fp,
    txnType: 'purchase', reviewFlag: true, finalSplitType: 'me',
  } as never);
  return {
    txnId: txn.id,
    signals: [{ source: 'normalize-seed' as const, confidence: 'low' as const, fields: { merchantClean } }],
    merchantKey: merchantClean,
    merchantRaw: merchantClean,
    merchantClean,
    merchantCanonical: null,
    amount: -7,
    date: '2026-06-01',
    currency: 'CAD',
    memory: null,
    accountVisibility: 'private' as const,
    txnType: 'purchase',
  };
}

test('above-threshold cold row is matched, persisted, removed from AI-batch set (AC #3,#6)', async () => {
  const hh = await models.Household.create({ name: 'H' } as never);
  const acc = await models.Account.create({ householdId: hh.id, name: 'C', visibility: 'private' } as never);
  await seedReviewedMerchant(hh.id, acc.id, 'Blue Bottle Coffee', 'Coffee');

  const cold = await coldTxn(hh.id, acc.id, 'SQ *BLUE BOTTLE');
  const result = await orch.maybeRunEmbeddingMatchOverColdRows([cold], hh.id, { embedder: toyEmbedder, threshold: 0.85 });

  assert.equal(result.summary.matched, 1);
  assert.equal(result.remainingColdRows.length, 0, 'matched row does NOT fall through to OpenAI batch');

  const updated = await models.Transaction.findByPk(cold.txnId);
  assert.equal(updated!.autoCategory, 'Coffee');
  assert.equal(updated!.autoSource, 'embedding');
  assert.equal(updated!.reviewFlag, false, 'review flag cleared');

  const sig = await models.TransactionSignal.findOne({ where: { transactionId: cold.txnId, source: 'embedding' } });
  assert.ok(sig, 'embedding signal persisted');
  assert.ok(sig!.rationale && sig!.rationale.includes('Blue Bottle Coffee'), 'rationale names matched merchant (AC #4)');
  assert.ok(['high', 'medium'].includes(sig!.confidence), 'confidence recorded (AC #5)');
});

test('below-threshold cold row is left for the OpenAI batch unchanged (AC #6)', async () => {
  const hh = await models.Household.create({ name: 'H' } as never);
  const acc = await models.Account.create({ householdId: hh.id, name: 'C', visibility: 'private' } as never);
  await seedReviewedMerchant(hh.id, acc.id, 'Blue Bottle Coffee', 'Coffee');

  const cold = await coldTxn(hh.id, acc.id, 'Totally Unrelated XYZ');
  const result = await orch.maybeRunEmbeddingMatchOverColdRows([cold], hh.id, { embedder: toyEmbedder, threshold: 0.85 });

  assert.equal(result.summary.matched, 0);
  assert.equal(result.remainingColdRows.length, 1, 'unmatched row reaches the AI batch candidate set');
  assert.equal(result.remainingColdRows[0].txnId, cold.txnId);
  const updated = await models.Transaction.findByPk(cold.txnId);
  assert.equal(updated!.reviewFlag, true, 'still cold');
});

test('custom threshold flips the boundary (AC #7)', async () => {
  const hh = await models.Household.create({ name: 'H' } as never);
  const acc = await models.Account.create({ householdId: hh.id, name: 'C', visibility: 'private' } as never);
  await seedReviewedMerchant(hh.id, acc.id, 'Blue Bottle Coffee', 'Coffee');

  // sim ~0.96 — matches at 0.85, not at 0.99.
  const cold1 = await coldTxn(hh.id, acc.id, 'SQ *BLUE BOTTLE');
  const lenient = await orch.maybeRunEmbeddingMatchOverColdRows([cold1], hh.id, { embedder: toyEmbedder, threshold: 0.85 });
  assert.equal(lenient.summary.matched, 1);

  const cold2 = await coldTxn(hh.id, acc.id, 'SQ *BLUE BOTTLE');
  const strict = await orch.maybeRunEmbeddingMatchOverColdRows([cold2], hh.id, { embedder: toyEmbedder, threshold: 0.99 });
  assert.equal(strict.summary.matched, 0);
});

test('household isolation: household B row never matches household A merchant (AC #10)', async () => {
  const a = await models.Household.create({ name: 'A' } as never);
  const b = await models.Household.create({ name: 'B' } as never);
  const accA = await models.Account.create({ householdId: a.id, name: 'CA', visibility: 'private' } as never);
  const accB = await models.Account.create({ householdId: b.id, name: 'CB', visibility: 'private' } as never);
  await seedReviewedMerchant(a.id, accA.id, 'Blue Bottle Coffee', 'Coffee');

  const coldB = await coldTxn(b.id, accB.id, 'SQ *BLUE BOTTLE');
  const result = await orch.maybeRunEmbeddingMatchOverColdRows([coldB], b.id, { embedder: toyEmbedder, threshold: 0.85 });
  assert.equal(result.summary.matched, 0, 'B has no priors, no match');
  assert.equal(result.remainingColdRows.length, 1);
});

test('a thrown embed call is swallowed — no throw, no signal, rows fall through (AC #11)', async () => {
  const hh = await models.Household.create({ name: 'H' } as never);
  const acc = await models.Account.create({ householdId: hh.id, name: 'C', visibility: 'private' } as never);
  await seedReviewedMerchant(hh.id, acc.id, 'Blue Bottle Coffee', 'Coffee');
  const cold = await coldTxn(hh.id, acc.id, 'SQ *BLUE BOTTLE');

  const boom: typeof Embedder = async () => { throw new Error('model load failed'); };
  const result = await orch.maybeRunEmbeddingMatchOverColdRows([cold], hh.id, { embedder: boom, threshold: 0.85 });
  assert.equal(result.summary.attempted, false);
  assert.equal(result.remainingColdRows.length, 1, 'row falls through to OpenAI batch on embedding failure');
});

test('empty merchant_clean is skipped (no embed, no signal)', async () => {
  const hh = await models.Household.create({ name: 'H' } as never);
  const acc = await models.Account.create({ householdId: hh.id, name: 'C', visibility: 'private' } as never);
  await seedReviewedMerchant(hh.id, acc.id, 'Blue Bottle Coffee', 'Coffee');

  const cold = await coldTxn(hh.id, acc.id, '   ');
  let calls = 0;
  const counting: typeof Embedder = async (t) => { calls += 1; return VECTORS[t] ?? [0, 0, 0.0001]; };
  const result = await orch.maybeRunEmbeddingMatchOverColdRows([cold], hh.id, { embedder: counting, threshold: 0.85 });
  assert.equal(result.summary.matched, 0);
  assert.equal(result.remainingColdRows.length, 1, 'whitespace merchant row stays cold');
});

test('local-first: matches with no OpenAI key / network (AC #12) — embed fn is local, no AI involved', async () => {
  const hh = await models.Household.create({ name: 'H' } as never);
  const acc = await models.Account.create({ householdId: hh.id, name: 'C', visibility: 'private' } as never);
  await seedReviewedMerchant(hh.id, acc.id, 'Blue Bottle Coffee', 'Coffee');
  const cold = await coldTxn(hh.id, acc.id, 'SQ *BLUE BOTTLE');
  // No OpenAI config touched; the injected embedder is purely local.
  const result = await orch.maybeRunEmbeddingMatchOverColdRows([cold], hh.id, { embedder: toyEmbedder, threshold: 0.85 });
  assert.equal(result.summary.matched, 1);
});
