/**
 * Cold-row accumulation used to be gated on `f.reviewFlag === true` alone.
 *
 * `reviewFlag` deliberately STAYS true on an AI-categorised row —
 * `hasNonAiHighConfidence` in computeReviewFlag.ts requires a non-`ai`
 * high-confidence signal, because an AI guess should still get human review.
 * That is correct and unchanged. But it meant an AI-categorised row was "cold"
 * again every single night, so the nightly backfill re-asked the model the exact
 * question it had already answered: a permanent 80-merchant/run spend floor that
 * bought nothing.
 *
 * The gate is now narrowed by prior fallback observations: a row that already
 * carries an `ai` (or `embedding`) signal is not re-sent. A MANUAL backfill can
 * still force a re-ask — a better model, a corrected category vocabulary — via
 * the explicit `forceFallbackReask` flag, which the nightly scheduler never
 * passes.
 *
 * Own file because `getOpenAiConfig()` reads OPENAI_API_KEY and node:test gives
 * each file its own process; the key is set here and no network is reached
 * because the caller is injected.
 */
process.env.OPENAI_API_KEY = 'test-key-not-used-no-network';

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, Account, Transaction, TransactionSignal, Household } from '../models';
import { runBackfill, type BackfillFlags } from './runEnrichmentBackfill';
import type { ChatMessage } from './enrichment/aiBatchStage';

const HH = 1;
let accountId: number;
let fp = 0;

before(async () => {
  await sequelize.sync({ force: true });
  await Household.create({ name: 'H' } as never);
  const account = await Account.create({ name: 'Test', householdId: HH } as never);
  accountId = account.id;
});

after(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  await TransactionSignal.destroy({ where: {} });
  await Transaction.destroy({ where: {} });
});

async function mkFlaggedTxn(merchant: string): Promise<Transaction> {
  fp += 1;
  return Transaction.create({
    accountId,
    householdId: HH,
    importBatch: 'test',
    date: '2026-06-01',
    merchantRaw: merchant,
    merchantClean: merchant,
    amount: '-15.49',
    currency: 'CAD',
    sourceRowFingerprint: `fp-${fp}`,
    sourceIdentityFingerprint: `sif-${fp}`,
    reviewFlag: true,
    reviewedAt: null,
  } as never);
}

function flags(overrides: Partial<BackfillFlags> = {}): BackfillFlags {
  return {
    dryRun: false,
    noReviewFlag: false,
    reviewOnly: false,
    verbose: false,
    accountId: null,
    householdId: HH,
    limit: null,
    batchSize: 100,
    dateFrom: null,
    dateTo: null,
    ai: true,
    ...overrides,
  };
}

/** Records every call so the test can assert the model was (not) asked. */
function recordingCaller(calls: ChatMessage[][]) {
  return async (msgs: ChatMessage[]): Promise<Record<string, unknown>> => {
    calls.push(msgs);
    return { results: {} };
  };
}

test('a cold row with no prior fallback signal IS sent to the AI batch', async () => {
  await mkFlaggedTxn('ZZQ NEVER SEEN CO');
  const calls: ChatMessage[][] = [];

  await runBackfill(flags(), {}, { aiCaller: recordingCaller(calls) });

  assert.ok(calls.length > 0, 'the control row reaches the model');
});

test('a row that already carries an ai signal is NOT re-sent to the AI batch', async () => {
  const txn = await mkFlaggedTxn('ZZQ ALREADY ASKED CO');
  await TransactionSignal.create({
    transactionId: txn.id,
    source: 'ai',
    confidence: 'medium',
    fields: { autoCategory: 'Dining', autoBusiness: false, autoSplitType: 'me' },
    rationale: 'asked last night',
  });
  const calls: ChatMessage[][] = [];

  await runBackfill(flags(), {}, { aiCaller: recordingCaller(calls) });

  assert.equal(calls.length, 0, 'the model is not re-asked what it already answered');
  await txn.reload();
  assert.equal(txn.autoCategory, 'Dining', 'and the row keeps the AI-set category');
});

test('a row that already carries an embedding signal is NOT re-sent to the AI batch', async () => {
  const txn = await mkFlaggedTxn('ZZQ EMBEDDED CO');
  await TransactionSignal.create({
    transactionId: txn.id,
    source: 'embedding',
    confidence: 'medium',
    fields: { autoCategory: 'Groceries', autoBusiness: false, autoSplitType: 'me' },
    rationale: 'similar merchant',
  });
  const calls: ChatMessage[][] = [];

  await runBackfill(flags(), {}, { aiCaller: recordingCaller(calls) });

  assert.equal(calls.length, 0);
  await txn.reload();
  assert.equal(txn.autoCategory, 'Groceries');
});

test('forceFallbackReask re-asks a row that already carries an ai signal', async () => {
  const txn = await mkFlaggedTxn('ZZQ REASK ME CO');
  await TransactionSignal.create({
    transactionId: txn.id,
    source: 'ai',
    confidence: 'medium',
    fields: { autoCategory: 'Dining', autoBusiness: false, autoSplitType: 'me' },
    rationale: 'answered by the old model',
  });
  const calls: ChatMessage[][] = [];

  await runBackfill(
    flags({ forceFallbackReask: true }),
    {},
    { aiCaller: recordingCaller(calls) },
  );

  assert.ok(calls.length > 0, 'an explicit force re-asks the model');
  const stale = await TransactionSignal.findAll({
    where: { transactionId: txn.id, source: 'ai' },
  });
  assert.equal(stale.length, 0, 'the superseded ai signal is cleared so the new answer wins');
});

test('the nightly scheduler never asks for a forced re-ask', async () => {
  await Household.findOrCreate({ where: { id: HH }, defaults: { name: 'H' } as never });
  const seen: BackfillFlags[] = [];
  const scheduler = await import('./enrichmentBackfillScheduler');

  await scheduler.runEnrichmentBackfillTick(
    { enabled: true },
    {
      runBackfill: async (f: BackfillFlags) => {
        seen.push(f);
        return {
          processed: 0,
          updated: 0,
          reviewFlagCleared: 0,
          signalsWritten: 0,
          skipped: 0,
          aiEnhanced: 0,
        };
      },
    },
  );

  assert.ok(seen.length > 0);
  for (const f of seen) {
    assert.notEqual(f.forceFallbackReask, true, 'the cron must never force a paid re-ask');
  }
});
