/**
 * Integration coverage for the embedding-match enrichment stage (#792).
 *
 * Drives the shared cold-row orchestration (runBackfill, which uses the SAME
 * module the import path uses) against Postgres with a seeded/stubbed local
 * embedder and a stubbed OpenAI caller — no model download, no network.
 *
 * Proves end-to-end:
 *   - A cold row semantically near a reviewed merchant gets an `embedding`
 *     signal and is NEVER seen by the OpenAI batch (AC #1,#3,#6).
 *   - A cold row with no near neighbor falls through and IS seen by the OpenAI
 *     batch (AC #6).
 *   - Stage ordering: embedding runs after merchant-memory, before the AI batch
 *     (AC #1,#2).
 *   - Cache persistence: re-running does not insert duplicate
 *     merchant_embeddings rows for the same (household, merchant, model) (AC #8,#9).
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { rowFingerprint, stableIdentityFingerprint } from '../../src/import/fingerprint';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';
import type { Embedder } from '../../src/ai/merchantEmbeddings.js';
import type { ChatMessage } from '../../src/import/enrichment/aiBatchStage.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let models: typeof import('../../src/models/index.js');
let backfillModule: typeof import('../../src/import/runEnrichmentBackfill.js');
let testDb: PgTestDb;

// Deterministic local embedder keyed by merchant string. "SQ *BLUE BOTTLE" is
// Anything containing "blue bottle" (the reviewed merchant or the cold variant,
// however normalize re-cleans it) maps to the coffee direction; "mystery"
// merchants are orthogonal to everything. Keyed by substring so the test does
// not depend on normalize's exact output string.
const stubEmbedder: Embedder = async (text: string): Promise<number[]> => {
  const t = text.toLowerCase();
  if (t.includes('blue bottle')) {
    // The reviewed prior is exactly "blue bottle coffee" (vector along x); the
    // cold "blue bottle" variant is ~0.97 cos similar.
    return t.includes('coffee') ? [1, 0, 0] : [0.97, Math.sqrt(1 - 0.97 * 0.97), 0];
  }
  if (t.includes('mystery')) return [0, 0, 1];
  return [0, 0.0001, 0];
};

const aiSeen: string[] = [];
const stubAiCaller = async (msgs: ChatMessage[]): Promise<Record<string, unknown>> => {
  // Record what the AI batch was asked about, then return no suggestions.
  const user = msgs.find((m) => m.role === 'user')?.content ?? '';
  aiSeen.push(user);
  return {};
};

before(async () => {
  process.env.ENRICHMENT_AI_ENABLED = 'true';
  process.env.ENRICHMENT_EMBEDDING_ENABLED = 'true';
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';

  testDb = await setupPgTestDb('embeddingmatch');
  models = await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;
  backfillModule = await import('../../src/import/runEnrichmentBackfill.js');
  authed = request.agent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'embed@example.com',
    displayName: 'Embed User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
  const account = await authed.post('/api/accounts').send({
    name: 'Embed Card',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(account.status, 201);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

beforeEach(() => {
  aiSeen.length = 0;
});

function seedFlags(over: Partial<Parameters<typeof backfillModule.runBackfill>[0]> = {}): Parameters<typeof backfillModule.runBackfill>[0] {
  return {
    dryRun: false, noReviewFlag: false, reviewOnly: false, verbose: false,
    accountId: null, householdId: null, limit: null, batchSize: 50,
    dateFrom: null, dateTo: null, ai: true, ...over,
  };
}

async function createTxn(opts: {
  merchantRaw: string;
  merchantClean: string;
  amount: number;
  date: string;
  reviewFlag: boolean;
  reviewedAt?: Date | null;
  finalCategory?: string | null;
}) {
  const acc = await models.Account.findOne();
  assert.ok(acc);
  return models.Transaction.create({
    accountId: acc.id,
    householdId: acc.householdId,
    createdByUserId: acc.ownerUserId,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'embed-test',
    date: opts.date,
    merchantRaw: opts.merchantRaw,
    merchantClean: opts.merchantClean,
    amount: String(opts.amount),
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: rowFingerprint({
      accountId: acc.id, date: opts.date, amount: opts.amount, currency: 'CAD',
      merchantRaw: opts.merchantRaw, sourceReference: '',
    }),
    sourceIdentityFingerprint: stableIdentityFingerprint({
      accountId: acc.id, date: opts.date, amount: opts.amount, currency: 'CAD',
      merchantRaw: opts.merchantRaw,
    }),
    txnType: 'purchase',
    reviewFlag: opts.reviewFlag,
    reviewedAt: opts.reviewedAt ?? null,
    finalCategory: opts.finalCategory ?? null,
    finalSplitType: 'me',
    isRecurring: false,
  } as never);
}

test('near cold row gets embedding signal and never reaches the OpenAI batch; far row does (AC #1,#3,#6)', async () => {
  // Reviewed prior the household has categorized — embedding-match learns from it.
  await createTxn({
    merchantRaw: 'BLUE BOTTLE COFFEE', merchantClean: 'Blue Bottle Coffee',
    amount: -5.5, date: '2026-05-01', reviewFlag: false,
    reviewedAt: new Date('2026-05-02'), finalCategory: 'Coffee',
  });
  // Cold row semantically near the prior (different string).
  const near = await createTxn({
    merchantRaw: 'SQ *BLUE BOTTLE', merchantClean: 'BLUE BOTTLE',
    amount: -6.25, date: '2026-06-01', reviewFlag: true,
  });
  // Cold row with no near neighbor.
  const far = await createTxn({
    merchantRaw: 'MYSTERY VENDOR Z', merchantClean: 'MYSTERY VENDOR Z',
    amount: -42, date: '2026-06-02', reviewFlag: true,
  });

  const result = await backfillModule.runBackfill(
    seedFlags(),
    {},
    { aiCaller: stubAiCaller, embedder: stubEmbedder },
  );
  assert.ok(result.processed >= 2);

  await near.reload();
  assert.equal(near.autoSource, 'embedding', 'near row categorized by embedding stage');
  assert.equal(near.autoCategory, 'Coffee');
  assert.equal(near.reviewFlag, false, 'near row review flag cleared');

  await far.reload();
  assert.equal(far.autoSource, null, 'far row not categorized by embedding stage');
  assert.equal(far.reviewFlag, true, 'far row stays cold');

  // The OpenAI batch must have been asked about the far merchant but NOT the
  // near one (the embedding stage consumed it first → strict ordering AC #1,#2).
  // We key on the near row's distinctive raw string "SQ *BLUE BOTTLE"; the
  // reviewed prior's own raw is "BLUE BOTTLE COFFEE", so a substring check on
  // "BLUE BOTTLE" alone would be ambiguous.
  const allAi = aiSeen.join('\n');
  assert.ok(allAi.includes('MYSTERY VENDOR Z'), 'far cold row reaches the AI batch');
  assert.ok(!allAi.includes('SQ *BLUE BOTTLE'), 'embedding-matched row never reaches the AI batch');

  const sig = await models.TransactionSignal.findOne({
    where: { transactionId: near.id, source: 'embedding' },
  });
  assert.ok(sig, 'embedding signal persisted');
  // Rationale names the matched prior merchant (the backfill may re-case the
  // stored merchant_clean, so match case-insensitively).
  assert.ok(
    sig!.rationale && /blue bottle/i.test(sig!.rationale),
    `rationale names matched merchant, got: ${sig!.rationale}`,
  );
});

test('re-running does not insert duplicate merchant_embeddings rows (AC #8,#9)', async () => {
  const acc = await models.Account.findOne();
  assert.ok(acc);
  const before = await models.MerchantEmbedding.count({ where: { householdId: acc.householdId! } });
  assert.ok(before > 0, 'first run populated the cache');

  await backfillModule.runBackfill(seedFlags(), {}, { aiCaller: stubAiCaller, embedder: stubEmbedder });

  const after = await models.MerchantEmbedding.count({ where: { householdId: acc.householdId! } });
  assert.equal(after, before, 'no duplicate cached vectors on re-run');
});
