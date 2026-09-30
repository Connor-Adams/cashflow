import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeReportingCashflow } from '../../reporting/cashflowTotals';
import { aggregateSankey } from '../../summary/aggregateSankey';
import { computeImportConfidence } from '../computeImportConfidence';

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

async function coldTxn(
  householdId: number,
  accountId: number,
  merchantClean: string,
  opts: { categoryOverride?: string | null } = {},
) {
  const fp = `cold-${Math.random()}`;
  const categoryOverride = opts.categoryOverride ?? null;
  const txn = await models.Transaction.create({
    accountId, householdId, visibility: 'private', importBatch: 'import',
    date: '2026-06-01', amount: '-7.00', currency: 'CAD',
    merchantRaw: merchantClean, merchantClean,
    sourceRowFingerprint: fp, sourceIdentityFingerprint: fp,
    txnType: 'purchase', reviewFlag: true, finalSplitType: 'me',
    categoryOverride,
    // A row carrying an override already has final_category resolved to it.
    finalCategory: categoryOverride,
  } as never);
  return {
    categoryOverride,
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

// --- skip reasons -----------------------------------------------------------
// `attempted: false` collapsed six different situations into one value, so an
// import where the embedder was missing was indistinguishable from an import
// with nothing to categorise. The reason is now on the summary.

test('a null embedder reports embedder_unavailable, not a generic skip', async () => {
  const hh = await models.Household.create({ name: 'H' } as never);
  const acc = await models.Account.create({ householdId: hh.id, name: 'C', visibility: 'private' } as never);
  await seedReviewedMerchant(hh.id, acc.id, 'Blue Bottle Coffee', 'Coffee');
  const cold = await coldTxn(hh.id, acc.id, 'SQ *BLUE BOTTLE');

  // No embedder injected and `@xenova/transformers` is not installed, so
  // getDefaultEmbedder() resolves null — the production container's state.
  const result = await orch.maybeRunEmbeddingMatchOverColdRows([cold], hh.id);
  assert.equal(result.summary.attempted, false);
  assert.equal(result.summary.skipReason, 'embedder_unavailable');
  assert.equal(result.remainingColdRows.length, 1);
});

test('a household with no reviewed priors reports no_priors (a cold start, not a fault)', async () => {
  const hh = await models.Household.create({ name: 'H' } as never);
  const acc = await models.Account.create({ householdId: hh.id, name: 'C', visibility: 'private' } as never);
  const cold = await coldTxn(hh.id, acc.id, 'SQ *BLUE BOTTLE');

  const result = await orch.maybeRunEmbeddingMatchOverColdRows([cold], hh.id, { embedder: toyEmbedder });
  assert.equal(result.summary.skipReason, 'no_priors');
});

test('an embedder that throws reports stage_error', async () => {
  const hh = await models.Household.create({ name: 'H' } as never);
  const acc = await models.Account.create({ householdId: hh.id, name: 'C', visibility: 'private' } as never);
  await seedReviewedMerchant(hh.id, acc.id, 'Blue Bottle Coffee', 'Coffee');
  const cold = await coldTxn(hh.id, acc.id, 'SQ *BLUE BOTTLE');

  const boom: typeof Embedder = async () => { throw new Error('model load failed'); };
  const result = await orch.maybeRunEmbeddingMatchOverColdRows([cold], hh.id, { embedder: boom });
  assert.equal(result.summary.skipReason, 'stage_error');
});

test('no cold rows reports no_cold_rows, and a successful run reports no reason at all', async () => {
  const hh = await models.Household.create({ name: 'H' } as never);
  const acc = await models.Account.create({ householdId: hh.id, name: 'C', visibility: 'private' } as never);
  await seedReviewedMerchant(hh.id, acc.id, 'Blue Bottle Coffee', 'Coffee');

  const none = await orch.maybeRunEmbeddingMatchOverColdRows([], hh.id, { embedder: toyEmbedder });
  assert.equal(none.summary.skipReason, 'no_cold_rows');

  const cold = await coldTxn(hh.id, acc.id, 'SQ *BLUE BOTTLE');
  const ran = await orch.maybeRunEmbeddingMatchOverColdRows([cold], hh.id, { embedder: toyEmbedder, threshold: 0.85 });
  assert.equal(ran.summary.attempted, true);
  assert.equal(ran.summary.skipReason, undefined);
});

test('a row with no household reports no_household', async () => {
  const result = await orch.maybeRunEmbeddingMatchOverColdRows(
    [{
      txnId: 1, signals: [], merchantKey: 'X', merchantRaw: 'X', merchantClean: 'X',
      merchantCanonical: null, amount: -1, date: '2026-06-01', currency: 'CAD',
      memory: null, accountVisibility: 'private' as const, txnType: 'purchase',
    }],
    null,
    { embedder: toyEmbedder },
  );
  assert.equal(result.summary.skipReason, 'no_household');
});

// ---------------------------------------------------------------------------
// final_category persistence (PR #1140 follow-up).
//
// Same defect as the AI stage: the static `Transaction.update` wrote
// `auto_category` and skipped `final_category`, the column the spend rollups
// and the Sankey aggregator actually read — so a matched row never left the
// uncategorised bucket. Asserted through the real read paths, because a
// column-only assertion would pass while nothing user-visible changed.
// ---------------------------------------------------------------------------

test('embedding-matched cold row lands in final_category and leaves the uncategorised bucket', async () => {
  const hh = await models.Household.create({ name: 'H' } as never);
  const acc = await models.Account.create({ householdId: hh.id, name: 'C', visibility: 'private' } as never);
  await seedReviewedMerchant(hh.id, acc.id, 'Blue Bottle Coffee', 'Coffee');

  const cold = await coldTxn(hh.id, acc.id, 'SQ *BLUE BOTTLE');
  const result = await orch.maybeRunEmbeddingMatchOverColdRows([cold], hh.id, {
    embedder: toyEmbedder,
    threshold: 0.85,
  });
  assert.equal(result.summary.matched, 1);

  const fresh = await models.Transaction.findByPk(cold.txnId);
  assert.ok(fresh);
  assert.equal(fresh.autoCategory, 'Coffee');
  assert.equal(fresh.finalCategory, 'Coffee', 'final_category is the column every rollup reads');

  // Read path 1: the reporting spend rollup.
  const totals = summarizeReportingCashflow(
    [{ amount: fresh.amount, txnType: fresh.txnType, finalCategory: fresh.finalCategory }],
    new Set(['coffee']),
  );
  assert.equal(totals.totalSpend, 7);
  assert.equal(totals.essentialSpend, 7, 'row is attributed to its category, not dropped');

  // Read path 2: the Sankey aggregator's uncategorised bucket.
  const sankey = aggregateSankey(
    [
      {
        id: fresh.id,
        date: fresh.date,
        currency: 'CAD',
        finalCategory: fresh.finalCategory,
        finalBusiness: false,
        merchantRaw: fresh.merchantRaw,
        merchantClean: fresh.merchantClean,
        amount: fresh.amount,
        txnType: fresh.txnType,
        accountType: null,
      },
    ],
    'CAD',
  );
  assert.equal(
    sankey.nodes.some((n) => n.kind === 'uncategorized'),
    false,
    'no uncategorised node remains',
  );
  assert.ok(sankey.nodes.some((n) => n.name === 'Coffee'));
});

test('embedding stage never clobbers a user categoryOverride in final_category', async () => {
  const hh = await models.Household.create({ name: 'H' } as never);
  const acc = await models.Account.create({ householdId: hh.id, name: 'C', visibility: 'private' } as never);
  await seedReviewedMerchant(hh.id, acc.id, 'Blue Bottle Coffee', 'Coffee');

  const cold = await coldTxn(hh.id, acc.id, 'SQ *BLUE BOTTLE', { categoryOverride: 'Groceries' });
  const result = await orch.maybeRunEmbeddingMatchOverColdRows([cold], hh.id, {
    embedder: toyEmbedder,
    threshold: 0.85,
  });
  assert.equal(result.summary.matched, 1);

  const fresh = await models.Transaction.findByPk(cold.txnId);
  assert.ok(fresh);
  // The match is still recorded as the machine's opinion...
  assert.equal(fresh.autoCategory, 'Coffee');
  // ...but the human's explicit choice still wins the resolved column.
  assert.equal(fresh.categoryOverride, 'Groceries');
  assert.equal(fresh.finalCategory, 'Groceries', 'user override beats autoCategory');
});

test('embedding stage import_confidence matches the final_category actually persisted', async () => {
  const hh = await models.Household.create({ name: 'H' } as never);
  const acc = await models.Account.create({ householdId: hh.id, name: 'C', visibility: 'private' } as never);
  await seedReviewedMerchant(hh.id, acc.id, 'Blue Bottle Coffee', 'Coffee');

  const cold = await coldTxn(hh.id, acc.id, 'SQ *BLUE BOTTLE');
  await orch.maybeRunEmbeddingMatchOverColdRows([cold], hh.id, {
    embedder: toyEmbedder,
    threshold: 0.85,
  });

  const fresh = await models.Transaction.findByPk(cold.txnId);
  assert.ok(fresh);
  // The stage tells computeImportConfidence that final_category is set; that
  // claim is only honest if the column really is set. `hasCategory` is
  // `finalCategory || autoCategory`, so blanking autoCategory is what actually
  // distinguishes a truthful call from a stand-in.
  const fromFinalCategoryAlone = computeImportConfidence({
    reviewFlag: fresh.reviewFlag,
    finalCategory: fresh.finalCategory,
    autoCategory: null,
    autoSplitType: fresh.autoSplitType,
    finalSplitType: fresh.finalSplitType,
    txnType: fresh.txnType,
    accountVisibility: 'private',
    linkedTransactionId: fresh.linkedTransactionId,
    amount: -7,
  });
  assert.equal(
    fromFinalCategoryAlone.flags.includes('missing_category'),
    false,
    'final_category alone satisfies the category check the stage claimed',
  );
  assert.equal(fresh.importConfidence, fromFinalCategoryAlone.state);
});

test('a match on a path-form prior persists the flat leaf name and the category id', async () => {
  const hh = await models.Household.create({ name: 'H' } as never);
  const acc = await models.Account.create({ householdId: hh.id, name: 'C', visibility: 'private' } as never);
  const houseRoot = await models.Category.create({
    householdId: hh.id, name: 'Household', parentId: null,
  } as never);
  const rent = await models.Category.create({
    householdId: hh.id, name: 'Rent', parentId: houseRoot.id,
  } as never);
  // ~200 production rows carry a path-form string in final_category, so a prior
  // this stage generalises from really can hand the writer a path. A path form
  // in that column matches no budget: every budget and spend rollup joins it as
  // an exact string.
  //
  // The prior has to be planted with a STATIC update, because that is the only
  // way such a row can exist: an instance save runs reconcileCategoryField,
  // which tries to mint a category named "Household / Rent" and the Category
  // beforeValidate hook rejects any name containing "/". The static writers this
  // test covers are the only door a path form can come through — which is also
  // why they must not write one.
  await seedReviewedMerchant(hh.id, acc.id, 'Blue Bottle Coffee', 'Coffee');
  await models.Transaction.update(
    { finalCategory: 'Household / Rent', finalCategoryId: null },
    { where: { merchantClean: 'Blue Bottle Coffee' } },
  );

  const cold = await coldTxn(hh.id, acc.id, 'SQ *BLUE BOTTLE');
  const result = await orch.maybeRunEmbeddingMatchOverColdRows([cold], hh.id, {
    embedder: toyEmbedder,
    threshold: 0.85,
  });
  assert.equal(result.summary.matched, 1);

  const fresh = await models.Transaction.findByPk(cold.txnId);
  assert.ok(fresh);
  assert.equal(fresh.finalCategory, 'Rent', 'the path form must never reach final_category');
  assert.equal(fresh.finalCategoryId, rent.id);
  assert.equal(fresh.autoCategory, 'Rent');
  assert.equal(fresh.autoCategoryId, rent.id);
  // The seed's own instance save minted a 'Coffee' node, so the household holds
  // Household + Rent + Coffee and nothing else: the writer reused the existing
  // Rent node rather than forking a new one off the path string.
  assert.equal(await models.Category.count({ where: { householdId: hh.id } }), 3);
  assert.equal(await models.Category.count({ where: { householdId: hh.id, name: 'Rent' } }), 1);
});
