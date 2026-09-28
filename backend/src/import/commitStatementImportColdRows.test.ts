/**
 * The statement import path — the one actually used — called `enrichTransaction`
 * and stopped there. Neither cold-row fallback ran: no embedding match, no AI
 * batch. Rows the deterministic stages could not categorise were simply left
 * with `review_flag = true` and forgotten until (and unless) a nightly backfill
 * happened to pick them up.
 *
 * These tests lock the wiring: the same two shared modules `runImport.ts` calls,
 * in the same order, on the same `reviewFlag === true` gate — plus the posture
 * that makes it safe (a fallback failure warns, and the import still commits)
 * and the visibility that makes it debuggable (an unavailable fallback says so).
 *
 * OPENAI_API_KEY is cleared here: a developer machine with the key set would
 * otherwise have these tests talking to a real proxy.
 */
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

import type { NormalizedCashTransaction, StatementPreview } from './statementTypes';
import type { Embedder } from '../ai/merchantEmbeddings';

let models: typeof import('../models');
let commitStatementImport: typeof import('./commitStatementImport').commitStatementImport;

before(async () => {
  delete process.env.OPENAI_API_KEY;
  models = await import('../models');
  await models.sequelize.sync({ force: true });
  commitStatementImport = (await import('./commitStatementImport')).commitStatementImport;
});

after(async () => {
  await models.sequelize.close();
});

beforeEach(async () => {
  delete process.env.OPENAI_API_KEY;
  await models.sequelize.sync({ force: true });
});

async function seedAccount(): Promise<{ householdId: number; accountId: number }> {
  const hh = await models.Household.create({ name: 'Cold Rows HH' } as never);
  const acc = await models.Account.create({
    name: `Visa ${Date.now()}-${Math.random()}`,
    owner: 'me',
    householdId: hh.id,
    defaultCurrency: 'CAD',
    accountType: 'credit_card',
    visibility: 'private',
  } as never);
  return { householdId: hh.id as number, accountId: acc.id as number };
}

/** A reviewed, categorised transaction — the embedding stage's prior set is
 *  built from exactly these (reviewed_at + final_category, per household). */
async function seedReviewedMerchant(
  householdId: number,
  accountId: number,
  merchantClean: string,
  category: string,
): Promise<void> {
  const fp = `prior-${Math.random()}`;
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

/** Matches anything that is not the seeded prior at cosine ~0.96, so the match
 *  does not depend on what the normalize stage makes of `merchantRaw`. */
const PRIOR_VECTOR = [1, 0, 0];
const NEAR_VECTOR = [0.96, Math.sqrt(1 - 0.96 * 0.96), 0];
function matchingEmbedder(priorMerchant: string): Embedder {
  return async (text: string) => (text === priorMerchant ? PRIOR_VECTOR : NEAR_VECTOR);
}
/** Orthogonal to the prior — nothing clears the threshold. */
const missingEmbedder: Embedder = async (text: string) =>
  text === 'Blue Bottle Coffee' ? PRIOR_VECTOR : [0, 0, 1];

function cashRow(nonce: string, merchantRaw: string): NormalizedCashTransaction {
  return {
    date: '2026-06-01',
    merchantRaw,
    merchantClean: merchantRaw,
    amount: -12.34,
    currency: 'CAD',
    sourceReference: null,
    sourceRowFingerprint: `row-${nonce}`,
  };
}

function makePreview(
  accountId: number,
  householdId: number,
  merchantRaw: string,
): StatementPreview {
  const nonce = `${Date.now()}-${Math.random()}`;
  return {
    previewToken: `tok-${nonce}`,
    fileName: 'visa-statement.pdf',
    contentHash: `hash-${nonce}`,
    accountId,
    householdId,
    importBatch: `batch-${nonce}`,
    usedParser: 'pdf',
    transactions: [cashRow(nonce, merchantRaw)],
    investmentActivities: [],
    holdings: [],
    warnings: [],
    rowErrors: 0,
    parseErrors: [],
    duplicateCounts: { transactions: 0, investmentActivities: 0, holdings: 0 },
  };
}

test('a cold row is categorised by the embedding stage during a statement commit', async () => {
  const { householdId, accountId } = await seedAccount();
  await seedReviewedMerchant(householdId, accountId, 'Blue Bottle Coffee', 'Coffee');

  const result = await commitStatementImport(
    makePreview(accountId, householdId, 'SQ *BLUE BOTTLE 8812'),
    null,
    householdId,
    {},
    { embedder: matchingEmbedder('Blue Bottle Coffee') },
  );

  assert.equal(result.insertedTransactions, 1);
  const txn = await models.Transaction.findOne({
    where: { importBatch: result.batchLabel },
  });
  assert.ok(txn, 'the statement row was committed');
  assert.equal(txn!.autoSource, 'embedding', 'the cold-row fallback actually ran on this path');
  assert.equal(txn!.autoCategory, 'Coffee');
  assert.equal(txn!.reviewFlag, false, 'review flag cleared by the fallback');

  const sig = await models.TransactionSignal.findOne({
    where: { transactionId: txn!.id, source: 'embedding' },
  });
  assert.ok(sig, 'an embedding signal was written');
  assert.equal(
    result.warnings.filter((w) => /embedding/i.test(w)).length,
    0,
    `a stage that ran must not warn, got ${JSON.stringify(result.warnings)}`,
  );
});

test('an unavailable embedder is reported on the import result instead of failing silently', async () => {
  const { householdId, accountId } = await seedAccount();
  await seedReviewedMerchant(householdId, accountId, 'Blue Bottle Coffee', 'Coffee');

  // No embedder injected: `@xenova/transformers` is an optional peer that is not
  // installed, so `getDefaultEmbedder()` resolves null — exactly production.
  const result = await commitStatementImport(
    makePreview(accountId, householdId, 'SHOPPERS DRUG MART #1234'),
    null,
    householdId,
  );

  assert.equal(result.insertedTransactions, 1, 'the import still commits');
  assert.ok(
    result.warnings.some((w) => /embedding/i.test(w)),
    `expected an embedding-unavailable warning, got ${JSON.stringify(result.warnings)}`,
  );
  const txn = await models.Transaction.findOne({ where: { importBatch: result.batchLabel } });
  assert.equal(txn!.reviewFlag, true, 'the row is still cold — nothing was invented');
});

test('an unconfigured AI batch is reported on the import result too', async () => {
  const { householdId, accountId } = await seedAccount();
  await seedReviewedMerchant(householdId, accountId, 'Blue Bottle Coffee', 'Coffee');

  const result = await commitStatementImport(
    makePreview(accountId, householdId, 'SHOPPERS DRUG MART #1234'),
    null,
    householdId,
    {},
    { embedder: missingEmbedder },
  );

  assert.equal(result.insertedTransactions, 1);
  assert.ok(
    result.warnings.some((w) => /AI/.test(w)),
    `expected an AI-unavailable warning, got ${JSON.stringify(result.warnings)}`,
  );
});

test('a fallback that throws never fails the import', async () => {
  const { householdId, accountId } = await seedAccount();
  await seedReviewedMerchant(householdId, accountId, 'Blue Bottle Coffee', 'Coffee');

  const boom: Embedder = async () => {
    throw new Error('model load exploded');
  };
  const result = await commitStatementImport(
    makePreview(accountId, householdId, 'SHOPPERS DRUG MART #1234'),
    null,
    householdId,
    {},
    { embedder: boom },
  );

  assert.equal(result.insertedTransactions, 1, 'the ledger row survived the fallback failure');
  const txn = await models.Transaction.findOne({ where: { importBatch: result.batchLabel } });
  assert.ok(txn, 'the transaction is committed and durable');
});

test('a row the deterministic stages already resolved is never handed to a fallback', async () => {
  const { householdId, accountId } = await seedAccount();
  await seedReviewedMerchant(householdId, accountId, 'Blue Bottle Coffee', 'Coffee');
  // A rule gives this row a category outright, so review_flag is cleared in
  // phase 1 and the cold-row gate (reviewFlag === true) must not pick it up.
  await models.Rule.create({
    householdId,
    merchantPattern: 'HYDRO',
    matchKind: 'substring',
    category: 'Utilities',
    splitType: 'me',
    priority: 1,
  } as never);

  let embedCalls = 0;
  const counting: Embedder = async (text: string) => {
    embedCalls += 1;
    return text === 'Blue Bottle Coffee' ? PRIOR_VECTOR : NEAR_VECTOR;
  };

  const result = await commitStatementImport(
    makePreview(accountId, householdId, 'BC HYDRO PAYMENT'),
    null,
    householdId,
    {},
    { embedder: counting },
  );

  assert.equal(result.insertedTransactions, 1);
  const txn = await models.Transaction.findOne({ where: { importBatch: result.batchLabel } });
  assert.equal(txn!.autoCategory, 'Utilities');
  assert.equal(txn!.reviewFlag, false);
  assert.equal(embedCalls, 0, 'no cold rows → the embedding stage never ran');
  assert.deepEqual(result.warnings, [], 'nothing to categorise → no unavailability noise');
});
