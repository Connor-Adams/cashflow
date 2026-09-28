/**
 * The AI half of the statement-import cold-row wiring, and the ordering
 * invariant that makes the pipeline economical: embedding match (free, local,
 * deterministic) runs FIRST and the paid AI batch only ever sees what the
 * embedder could not resolve.
 *
 * Own file because `getOpenAiConfig()` reads OPENAI_API_KEY, and node:test
 * gives each test file its own process.
 */
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key-not-used-no-network';

import type { NormalizedCashTransaction, StatementPreview } from './statementTypes';
import type { Embedder } from '../ai/merchantEmbeddings';
import type { ChatMessage } from './enrichment/aiBatchStage';

let models: typeof import('../models');
let commitStatementImport: typeof import('./commitStatementImport').commitStatementImport;

before(async () => {
  models = await import('../models');
  await models.sequelize.sync({ force: true });
  commitStatementImport = (await import('./commitStatementImport')).commitStatementImport;
});

after(async () => {
  await models.sequelize.close();
});

beforeEach(async () => {
  await models.sequelize.sync({ force: true });
});

async function seedAccount(): Promise<{ householdId: number; accountId: number }> {
  const hh = await models.Household.create({ name: 'AI Cold Rows HH' } as never);
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

function cashRow(nonce: string, merchantRaw: string, suffix: string): NormalizedCashTransaction {
  return {
    date: '2026-06-01',
    merchantRaw,
    merchantClean: merchantRaw,
    amount: -12.34,
    currency: 'CAD',
    sourceReference: null,
    sourceRowFingerprint: `row-${nonce}-${suffix}`,
  };
}

function makePreview(
  accountId: number,
  householdId: number,
  merchants: string[],
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
    transactions: merchants.map((m, i) => cashRow(nonce, m, String(i))),
    investmentActivities: [],
    holdings: [],
    warnings: [],
    rowErrors: 0,
    parseErrors: [],
    duplicateCounts: { transactions: 0, investmentActivities: 0, holdings: 0 },
  };
}

/** Responds to whatever merchant keys the prompt carried, so the stub never has
 *  to know what the normalize stage produced. */
function respondingCaller(
  seenPrompts: string[],
  category: string,
): (msgs: ChatMessage[]) => Promise<Record<string, unknown>> {
  return async (msgs: ChatMessage[]) => {
    const prompt = msgs.map((m) => m.content).join('\n');
    seenPrompts.push(prompt);
    const keys = [...prompt.matchAll(/merchant_key: "([^"]+)"/g)].map((m) => m[1]);
    const results: Record<string, unknown> = {};
    for (const k of keys) {
      results[k] = {
        category,
        business: false,
        splitType: 'me',
        pctMe: null,
        pctPartner: null,
        confidence: 'high',
        rationale: `stubbed for ${k}`,
      };
    }
    return { results };
  };
}

test('a row the embedder could not match is categorised by the AI batch on the statement path', async () => {
  const { householdId, accountId } = await seedAccount();
  const prompts: string[] = [];

  // An available embedder over a household with no reviewed priors: the free
  // stage is present and simply has nothing to generalise from.
  const embedder: Embedder = async () => [1, 0, 0];
  const result = await commitStatementImport(
    makePreview(accountId, householdId, ['SHOPPERS DRUG MART #1234']),
    null,
    householdId,
    {},
    { embedder, aiCaller: respondingCaller(prompts, 'Healthcare') },
  );

  assert.equal(result.insertedTransactions, 1);
  assert.equal(prompts.length, 1, 'the AI batch was actually invoked');
  const txn = await models.Transaction.findOne({ where: { importBatch: result.batchLabel } });
  assert.equal(txn!.autoSource, 'ai', 'the AI fallback ran on the statement path');
  assert.equal(txn!.autoCategory, 'Healthcare');
  // An AI suggestion is a proposal, not a verdict: computeReviewFlag clears the
  // flag only on a HIGH-confidence NON-ai signal, so the row keeps
  // review_flag=true and lands in the review queue with a category attached.
  // That is the designed behaviour and this test pins it, because it is also why
  // an AI-categorised row stays a cold row on the next sweep.
  assert.equal(txn!.reviewFlag, true);
  assert.deepEqual(
    result.warnings,
    [],
    `both fallbacks were available, so nothing to warn about: ${JSON.stringify(result.warnings)}`,
  );
});

test('ordering: the AI batch only sees the rows embedding match could not resolve', async () => {
  const { householdId, accountId } = await seedAccount();
  await seedReviewedMerchant(householdId, accountId, 'Blue Bottle Coffee', 'Coffee');

  // The embedder matches the coffee row to the seeded prior (~0.96) and leaves
  // the pharmacy row orthogonal.
  const embedder: Embedder = async (text: string) => {
    if (text === 'Blue Bottle Coffee') return [1, 0, 0];
    if (/BLUE BOTTLE/i.test(text)) return [0.96, Math.sqrt(1 - 0.96 * 0.96), 0];
    return [0, 0, 1];
  };

  const prompts: string[] = [];
  const result = await commitStatementImport(
    makePreview(accountId, householdId, ['SQ *BLUE BOTTLE 8812', 'SHOPPERS DRUG MART #1234']),
    null,
    householdId,
    {},
    { embedder, aiCaller: respondingCaller(prompts, 'Healthcare') },
  );

  assert.equal(result.insertedTransactions, 2);
  assert.equal(prompts.length, 1, 'one batch call');
  assert.match(prompts[0], /SHOPPERS/i, 'the unmatched row reached the AI batch');
  assert.doesNotMatch(
    prompts[0],
    /BLUE BOTTLE/i,
    'a row embedding match already resolved must never be paid for again',
  );

  const rows = await models.Transaction.findAll({
    where: { importBatch: result.batchLabel },
    order: [['merchantRaw', 'ASC']],
  });
  const sources = rows.map((r) => r.autoSource).sort();
  assert.deepEqual(sources, ['ai', 'embedding']);
  assert.equal(
    rows.filter((r) => r.autoCategory == null).length,
    0,
    'both rows came out of the commit with a category',
  );
  // Only the embedding match clears review: it generalises from a merchant the
  // household itself already reviewed, so it inherits that verdict. The AI row
  // stays flagged for a human.
  const bySource = new Map(rows.map((r) => [r.autoSource, r]));
  assert.equal(bySource.get('embedding')!.reviewFlag, false);
  assert.equal(bySource.get('ai')!.reviewFlag, true);
});

test('an AI caller that throws leaves the rows cold and the import committed', async () => {
  const { householdId, accountId } = await seedAccount();

  const result = await commitStatementImport(
    makePreview(accountId, householdId, ['SHOPPERS DRUG MART #1234']),
    null,
    householdId,
    {},
    {
      aiCaller: async () => {
        throw new Error('proxy exploded');
      },
    },
  );

  assert.equal(result.insertedTransactions, 1, 'the import is unaffected by an AI failure');
  const txn = await models.Transaction.findOne({ where: { importBatch: result.batchLabel } });
  assert.equal(txn!.reviewFlag, true, 'still cold — no invented category');
});
