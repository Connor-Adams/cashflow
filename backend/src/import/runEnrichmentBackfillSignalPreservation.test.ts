/**
 * The nightly backfill re-derives enrichment from scratch for every row, then
 * used to `TransactionSignal.destroy({ where: { transactionId } })` before
 * writing the freshly-derived deterministic signals back.
 *
 * `enrichTransaction` can only ever produce deterministic-stage signals — the
 * `ai` and `embedding` stages run AFTER the row loop, over accumulated cold
 * rows. So the blanket destroy deleted every persisted `ai` / `embedding`
 * signal and, because those signals are what supplied `auto_category` through
 * `mergeSignals` precedence, nulled the category they had set. A row enhanced
 * on an earlier run and not re-selected by this run's 80-merchant AI budget
 * lost its category outright: a user's category silently disappeared.
 *
 * These tests pin the invariant: deterministic signals are still replaced (that
 * is the point of a backfill), but `ai` / `embedding` signals are prior
 * observations a deterministic sweep cannot re-derive, so they survive and
 * still win the merge.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, Account, Transaction, TransactionSignal, Household } from '../models';
import { runBackfill, type BackfillFlags } from './runEnrichmentBackfill';

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

/** A review-flagged row whose merchant no rule or memory can classify. */
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
    ...overrides,
  };
}

test('an existing ai signal survives the backfill and keeps its category', async () => {
  const txn = await mkFlaggedTxn('ZZQ UNCLASSIFIABLE CO');
  await Transaction.update(
    { autoCategory: 'Dining', autoSource: 'ai', autoConfidence: 'medium' },
    { where: { id: txn.id } },
  );
  const aiSignal = await TransactionSignal.create({
    transactionId: txn.id,
    source: 'ai',
    confidence: 'medium',
    fields: { autoCategory: 'Dining', autoBusiness: false, autoSplitType: 'me' },
    rationale: 'looks like a restaurant',
  });

  await runBackfill(flags());

  const surviving = await TransactionSignal.findAll({
    where: { transactionId: txn.id, source: 'ai' },
  });
  assert.equal(surviving.length, 1, 'the ai signal row is preserved, not deleted and re-created');
  assert.equal(surviving[0].id, aiSignal.id, 'the SAME row survives (same primary key)');

  await txn.reload();
  assert.equal(txn.autoCategory, 'Dining', 'the AI-set category is not nulled');
  assert.equal(txn.autoSource, 'ai');
  assert.equal(txn.autoConfidence, 'medium');
});

test('an existing embedding signal survives the backfill and keeps its category', async () => {
  const txn = await mkFlaggedTxn('ZZQ OTHER UNCLASSIFIABLE CO');
  const embSignal = await TransactionSignal.create({
    transactionId: txn.id,
    source: 'embedding',
    confidence: 'high',
    fields: { autoCategory: 'Groceries', autoBusiness: false, autoSplitType: 'me' },
    rationale: 'similar merchant',
  });

  await runBackfill(flags());

  const surviving = await TransactionSignal.findAll({
    where: { transactionId: txn.id, source: 'embedding' },
  });
  assert.equal(surviving.length, 1, 'the embedding signal row is preserved');
  assert.equal(surviving[0].id, embSignal.id);

  await txn.reload();
  assert.equal(txn.autoCategory, 'Groceries');
  assert.equal(txn.autoSource, 'embedding');
});

test('deterministic signals are still replaced — a stale rule signal is dropped', async () => {
  const txn = await mkFlaggedTxn('ZZQ THIRD UNCLASSIFIABLE CO');
  await TransactionSignal.create({
    transactionId: txn.id,
    source: 'rule',
    confidence: 'high',
    fields: { autoCategory: 'Stale Category' },
    rationale: 'a rule that no longer exists',
  });

  await runBackfill(flags());

  const rules = await TransactionSignal.findAll({
    where: { transactionId: txn.id, source: 'rule' },
  });
  assert.equal(rules.length, 0, 'the stale deterministic signal is gone');

  await txn.reload();
  assert.equal(txn.autoCategory, null, 'and its category claim no longer applies');
});
