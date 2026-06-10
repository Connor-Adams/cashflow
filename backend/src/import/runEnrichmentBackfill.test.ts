/**
 * Pagination regression tests for runBackfill.
 *
 * A reviewOnly run mutates its own predicate: every row whose review flag is
 * cleared drops OUT of the `where.reviewFlag = true` result set. Offset-based
 * pagination over that shrinking set silently skips still-flagged rows that
 * shifted left, so the loop must paginate by keyset instead.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, Account, Rule, Transaction, TransactionSignal } from '../models';
import { runBackfill, type BackfillFlags } from './runEnrichmentBackfill';

const HH = 1;
let accountId: number;
let fp = 0;

before(async () => {
  await sequelize.sync({ force: true });
  const account = await Account.create({ name: 'Test', householdId: HH } as never);
  accountId = account.id;
});

beforeEach(async () => {
  await TransactionSignal.destroy({ where: {} });
  await Transaction.destroy({ where: {} });
  await Rule.destroy({ where: {} });
});

async function mkFlaggedTxn(opts: { date: string; merchant: string }): Promise<Transaction> {
  fp += 1;
  return Transaction.create({
    accountId,
    householdId: HH,
    importBatch: 'test',
    date: opts.date,
    merchantRaw: opts.merchant,
    merchantClean: opts.merchant,
    amount: '-15.49',
    currency: 'CAD',
    sourceRowFingerprint: `fp-${fp}`,
    sourceIdentityFingerprint: `sif-${fp}`,
    reviewFlag: true,
    reviewedAt: null,
  } as never);
}

function flags(overrides: Partial<BackfillFlags>): BackfillFlags {
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

test('reviewOnly run processes every flagged row even when batches clear flags', async () => {
  // A high-priority rule gives every NETFLIX row a high-confidence category,
  // which clears reviewFlag — shrinking the reviewOnly predicate as the loop runs.
  await Rule.create({
    householdId: HH,
    merchantPattern: 'NETFLIX',
    matchKind: 'contains',
    priority: 10,
    category: 'Subscriptions',
    isBusiness: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
  } as never);

  const rows: Transaction[] = [];
  for (let i = 1; i <= 5; i++) {
    rows.push(await mkFlaggedTxn({ date: `2026-01-0${i}`, merchant: 'NETFLIX.COM' }));
  }

  const result = await runBackfill(flags({ reviewOnly: true, batchSize: 2 }));

  assert.equal(result.processed, 5, 'every flagged row must be processed in one run');
  assert.equal(result.reviewFlagCleared, 5);

  const stillFlagged = await Transaction.count({ where: { householdId: HH, reviewFlag: true } });
  assert.equal(stillFlagged, 0, 'no flagged row may be skipped by pagination');
});
