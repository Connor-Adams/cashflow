/**
 * Trigger 1: a statement that lands new billed interest reallocates it.
 *
 * `captureRatePeriods` already knows whether it wrote or updated any windows —
 * that is the signal. New Applicable Interest is the primary input to the
 * line-of-credit interest allocation, so a statement carrying it must leave the
 * household queued for recomputation, and a statement carrying none must not.
 *
 * The queue, not the allocator, is what these tests observe: an import handler
 * is the wrong place to spend a full household recomputation, and marking is
 * the only part of it that is synchronous with the commit.
 *
 * The containment property from ./commitRatePeriods.test.ts is re-asserted here
 * from the other direction: a reallocation that fails must not cost the import.
 */
import { after, before, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PdfRatePeriod } from './pdf/types';
import type { NormalizedCashTransaction, StatementPreview } from './statementTypes';
import {
  isInterestAllocationPending,
  waitForInterestAllocationDrain,
  _resetInterestAllocationCoordinatorForTest,
  _setInterestAllocationCoordinatorForTest,
} from '../contacts/interestAllocationCoordinator';

process.env.DATABASE_PATH = ':memory:';

let models: typeof import('../models/index.js');
let commitStatementImport: typeof import('./commitStatementImport.js').commitStatementImport;

/**
 * Park the queue: these tests are about whether the trigger fires, and a real
 * allocation would need rate windows and a contact ledger they do not build.
 * A very long debounce means nothing drains unless a test asks it to.
 */
function parkQueue(): void {
  _resetInterestAllocationCoordinatorForTest();
  _setInterestAllocationCoordinatorForTest({
    debounceMs: 60_000,
    runner: async () => ({
      windows: 0,
      allocations: 0,
      totalCharged: '0.0000',
      windowSummaries: [],
      dryRun: false,
      elapsedMs: 0,
    }),
  });
}

before(async () => {
  models = await import('../models/index.js');
  await models.sequelize.sync({ force: true });
  commitStatementImport = (await import('./commitStatementImport.js')).commitStatementImport;
});

beforeEach(async () => {
  mock.restoreAll();
  await models.sequelize.sync({ force: true });
  parkQueue();
});

after(async () => {
  mock.restoreAll();
  _resetInterestAllocationCoordinatorForTest();
  await models.sequelize.close();
});

async function seedAccount(): Promise<{ householdId: number; accountId: number }> {
  const hh = await models.Household.create({ name: 'Rate Trigger HH' } as never);
  const acc = await models.Account.create({
    name: 'RBC Royal Credit Line',
    owner: 'me',
    householdId: hh.id,
    defaultCurrency: 'CAD',
    accountType: 'loan',
    visibility: 'private',
  } as never);
  return { householdId: hh.id as number, accountId: acc.id as number };
}

function cashRow(suffix: string): NormalizedCashTransaction {
  return {
    date: '2026-03-15',
    merchantRaw: `INTEREST CHARGE ${suffix}`,
    merchantClean: `INTEREST CHARGE ${suffix}`,
    amount: -125.5,
    currency: 'CAD',
    sourceReference: null,
    sourceRowFingerprint: `fp-trigger-${suffix}`,
  };
}

function ratePeriod(overrides: Partial<PdfRatePeriod> = {}): PdfRatePeriod {
  return {
    fromDate: '2026-02-09',
    toDate: '2026-03-08',
    primeRate: '4.4500',
    premium: '4.4900',
    effectiveRate: '8.9400',
    applicableInterest: '123.4500',
    ...overrides,
  };
}

function makePreview(
  accountId: number,
  householdId: number,
  opts: { ratePeriods?: PdfRatePeriod[]; contentHash?: string } = {},
): StatementPreview {
  const nonce = `${Date.now()}-${Math.random()}`;
  return {
    previewToken: `tok-${nonce}`,
    fileName: 'rbc-credit-line.pdf',
    contentHash: opts.contentHash ?? `hash-${nonce}`,
    accountId,
    householdId,
    importBatch: `batch-${nonce}`,
    usedParser: 'pdf',
    transactions: [cashRow(nonce)],
    investmentActivities: [],
    holdings: [],
    warnings: [],
    rowErrors: 0,
    parseErrors: [],
    duplicateCounts: { transactions: 0, investmentActivities: 0, holdings: 0 },
    ...(opts.ratePeriods ? { ratePeriods: opts.ratePeriods } : {}),
  };
}

test('committing a statement that writes rate periods queues a reallocation', async () => {
  const { householdId, accountId } = await seedAccount();
  const result = await commitStatementImport(
    makePreview(accountId, householdId, { ratePeriods: [ratePeriod()] }),
    null,
    householdId,
  );

  assert.equal(result.insertedTransactions, 1);
  assert.equal(await models.AccountRatePeriod.count({ where: { accountId } }), 1);
  assert.equal(
    isInterestAllocationPending(householdId),
    true,
    'new billed interest must not wait for someone to press a button',
  );
});

test('committing a statement with no rate periods queues nothing', async () => {
  const { householdId, accountId } = await seedAccount();
  const result = await commitStatementImport(makePreview(accountId, householdId), null, householdId);

  assert.equal(result.insertedTransactions, 1);
  assert.equal(await models.AccountRatePeriod.count({ where: { accountId } }), 0);
  assert.equal(
    isInterestAllocationPending(householdId),
    false,
    'a statement with no rate table moves no allocation input — recomputing would be waste',
  );
});

test('the already-imported path still queues when it captures a window', async () => {
  // The five-month rate-history hole was re-imported through exactly this path
  // (see commitRatePeriods.test.ts). Windows written here are windows the
  // allocation has never seen, so they must trigger just as loudly.
  const { householdId, accountId } = await seedAccount();
  const contentHash = `hash-shared-${Date.now()}-${Math.random()}`;
  await commitStatementImport(
    makePreview(accountId, householdId, { contentHash }),
    null,
    householdId,
  );
  parkQueue();

  const again = await commitStatementImport(
    makePreview(accountId, householdId, {
      contentHash,
      ratePeriods: [ratePeriod({ fromDate: '2025-12-04', toDate: '2026-01-03' })],
    }),
    null,
    householdId,
  );

  assert.equal(again.insertedTransactions, 0, 'the dedupe path must still insert nothing');
  assert.equal(isInterestAllocationPending(householdId), true);
});

test('a rate-persistence failure queues nothing and still commits the ledger', async () => {
  const { householdId, accountId } = await seedAccount();
  mock.method(models.AccountRatePeriod, 'findOne', () => {
    throw new Error('rate table exploded');
  });

  const result = await commitStatementImport(
    makePreview(accountId, householdId, { ratePeriods: [ratePeriod()] }),
    null,
    householdId,
  );

  assert.equal(result.insertedTransactions, 1, 'transactions must survive a rate failure');
  assert.equal(
    isInterestAllocationPending(householdId),
    false,
    'no window was written, so there is nothing new to allocate',
  );
});

test('a reallocation that throws does not fail the import', async () => {
  // The queue drains on its own timer, outside the commit. Even when the
  // allocator itself blows up, the import that triggered it is untouched and
  // nothing escapes as an unhandled rejection.
  const { householdId, accountId } = await seedAccount();
  let attempted = 0;
  _resetInterestAllocationCoordinatorForTest();
  _setInterestAllocationCoordinatorForTest({
    debounceMs: 0,
    runner: async () => {
      attempted += 1;
      throw new Error('allocator exploded');
    },
  });

  const result = await commitStatementImport(
    makePreview(accountId, householdId, { ratePeriods: [ratePeriod()] }),
    null,
    householdId,
  );
  await waitForInterestAllocationDrain();

  assert.equal(result.insertedTransactions, 1, 'the ledger is the reason to import a statement');
  assert.equal(
    await models.AccountRatePeriod.count({ where: { accountId } }),
    1,
    'the rate window itself must still have been written',
  );
  assert.equal(attempted, 1, 'the trigger did fire — it just failed, loudly and harmlessly');
  assert.deepEqual(
    result.warnings.filter((w) => /rate history not saved/i.test(w)),
    [],
    'a failed reallocation is not a rate-capture failure and must not be reported as one',
  );
});
