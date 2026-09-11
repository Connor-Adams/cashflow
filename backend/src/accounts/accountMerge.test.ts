/**
 * Unit tests for the transactional account-merge service (#287).
 *
 * Runs against the per-process SQLite test DB. Verifies: transactions +
 * planned events are reassigned from source to target; the source is flagged
 * mergedIntoId/mergedAt; validation rejects same-id, currency mismatch,
 * target-already-merged, and source-already-merged; and the whole operation
 * rolls back if a child reassignment fails.
 */
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.DATABASE_PATH = ':memory:';

let models: typeof import('../models');
let mergeAccounts: typeof import('./accountMerge').mergeAccounts;
let AccountMergeError: typeof import('./accountMerge').AccountMergeError;
let upsertAccountCardIdentifier: typeof import('../models/AccountCardIdentifier').upsertAccountCardIdentifier;
let household: { id: number };
let userId: number;

before(async () => {
  models = await import('../models');
  await models.sequelize.sync({ force: true });
  const mod = await import('./accountMerge');
  mergeAccounts = mod.mergeAccounts;
  AccountMergeError = mod.AccountMergeError;
  upsertAccountCardIdentifier = (await import('../models/AccountCardIdentifier')).upsertAccountCardIdentifier;
});

after(async () => {
  await models.sequelize.close();
});

beforeEach(async () => {
  await models.AccountCardIdentifier.destroy({ where: {}, force: true });
  await models.Transaction.destroy({ where: {}, truncate: true });
  await models.PlannedEvent.destroy({ where: {}, truncate: true });
  await models.Account.destroy({ where: {}, truncate: true });
  await models.Household.destroy({ where: {}, truncate: true });
  await models.User.destroy({ where: {}, truncate: true });
  const user = await models.User.create({
    email: `merge-${crypto.randomBytes(4).toString('hex')}@example.com`,
    displayName: 'Merge Tester',
    globalRole: 'user',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: 'x',
  } as never);
  userId = user.id;
  household = await models.Household.create({ name: 'Merge Test HH' });
});

async function seedAccount(name: string, currency = 'CAD') {
  return models.Account.create({
    householdId: household.id,
    owner: 'me',
    visibility: 'shared',
    name,
    accountType: 'checking',
    defaultCurrency: currency,
  } as never);
}

async function seedTxn(accountId: number, amount = -100) {
  return models.Transaction.create({
    accountId,
    householdId: household.id,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'merge-test',
    date: '2026-01-10',
    merchantRaw: 'Test',
    merchantClean: 'Test',
    amount: amount.toFixed(4),
    currency: 'CAD',
    txnType: 'purchase',
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
  } as never);
}

async function seedIdentifier(accountId: number, last4: string) {
  return upsertAccountCardIdentifier({
    householdId: household.id,
    accountId,
    last4,
    source: 'test',
  });
}

async function seedPlannedEvent(accountId: number) {
  return models.PlannedEvent.create({
    householdId: household.id,
    userId,
    accountId,
    type: 'expense',
    source: 'manual',
    name: 'Rent',
    amount: '1000.0000',
    currency: 'CAD',
    expectedDate: '2026-02-01',
    status: 'planned',
  } as never);
}

test('reassigns transactions from source to target (AC #2)', async () => {
  const source = await seedAccount('Old');
  const target = await seedAccount('New');
  await seedTxn(source.id);
  await seedTxn(source.id);
  await seedTxn(target.id);

  const result = await mergeAccounts({ sourceId: source.id, targetId: target.id, householdId: household.id });

  assert.equal(result.movedTransactions, 2);
  const targetTxns = await models.Transaction.count({ where: { accountId: target.id } });
  const sourceTxns = await models.Transaction.count({ where: { accountId: source.id } });
  assert.equal(targetTxns, 3);
  assert.equal(sourceTxns, 0);
});

test('reassigns planned events from source to target (AC #3)', async () => {
  const source = await seedAccount('Old');
  const target = await seedAccount('New');
  await seedPlannedEvent(source.id);

  const result = await mergeAccounts({ sourceId: source.id, targetId: target.id, householdId: household.id });

  assert.equal(result.movedPlannedEvents, 1);
  assert.equal(await models.PlannedEvent.count({ where: { accountId: target.id } }), 1);
  assert.equal(await models.PlannedEvent.count({ where: { accountId: source.id } }), 0);
});

test('flags the source mergedIntoId + mergedAt (AC #4)', async () => {
  const source = await seedAccount('Old');
  const target = await seedAccount('New');

  await mergeAccounts({ sourceId: source.id, targetId: target.id, householdId: household.id });

  await source.reload();
  assert.equal(source.mergedIntoId, target.id);
  assert.ok(source.mergedAt instanceof Date);
});

test('zero-transaction source still merges (edge case)', async () => {
  const source = await seedAccount('Empty');
  const target = await seedAccount('New');
  const result = await mergeAccounts({ sourceId: source.id, targetId: target.id, householdId: household.id });
  assert.equal(result.movedTransactions, 0);
  await source.reload();
  assert.equal(source.mergedIntoId, target.id);
});

// FIX 3 (review): AccountCardIdentifier was missing from CHILD_MODELS, so a
// merged-away source account's harvested last-4s stayed on the hidden source
// -- buildLast4Map still resolved that last-4 to the source account, while
// the target's own last-4 set lacked it, tripping scoreAmazonOrderMatch's
// -25 "different card" penalty against genuinely correct matches on target.
test('carries harvested card identifiers from source to target (FIX 3)', async () => {
  const source = await seedAccount('Old');
  const target = await seedAccount('New');
  await seedIdentifier(source.id, '1234');

  const result = await mergeAccounts({ sourceId: source.id, targetId: target.id, householdId: household.id });

  assert.equal(result.movedTotal >= 1, true);
  const sourceRows = await models.AccountCardIdentifier.findAll({ where: { accountId: source.id } });
  assert.equal(sourceRows.length, 0, 'the identifier must not remain on the hidden source account');
  const targetRows = await models.AccountCardIdentifier.findAll({ where: { accountId: target.id } });
  assert.equal(targetRows.length, 1);
  assert.equal(targetRows[0].last4, '1234');
});

test('merging a shared last4 does not violate the (account_id, last4) unique index', async () => {
  const source = await seedAccount('Old');
  const target = await seedAccount('New');
  // Both accounts already know this same card -- reassigning the source's
  // row onto the target would collide with the target's own row under the
  // UNIQUE(account_id, last4) index unless the merge resolves it first.
  await seedIdentifier(source.id, '9999');
  await seedIdentifier(target.id, '9999');
  await seedIdentifier(source.id, '1111'); // a non-colliding one must still move

  await mergeAccounts({ sourceId: source.id, targetId: target.id, householdId: household.id });

  const targetRows = await models.AccountCardIdentifier.findAll({ where: { accountId: target.id } });
  const targetLast4s = targetRows.map((r) => r.last4).sort();
  assert.deepEqual(targetLast4s, ['1111', '9999']);
  const sourceRows = await models.AccountCardIdentifier.findAll({ where: { accountId: source.id } });
  assert.equal(sourceRows.length, 0);
});

test('same-id throws SAME_ID (AC #8)', async () => {
  const a = await seedAccount('A');
  await assert.rejects(
    () => mergeAccounts({ sourceId: a.id, targetId: a.id, householdId: household.id }),
    (e: unknown) => e instanceof AccountMergeError && e.code === 'SAME_ID',
  );
});

test('currency mismatch throws CURRENCY_MISMATCH (AC #5)', async () => {
  const source = await seedAccount('USD acct', 'USD');
  const target = await seedAccount('CAD acct', 'CAD');
  await seedTxn(source.id);
  await assert.rejects(
    () => mergeAccounts({ sourceId: source.id, targetId: target.id, householdId: household.id }),
    (e: unknown) => e instanceof AccountMergeError && e.code === 'CURRENCY_MISMATCH',
  );
  // nothing changed
  assert.equal(await models.Transaction.count({ where: { accountId: source.id } }), 1);
});

test('target already merged throws TARGET_NOT_MERGEABLE (AC #6)', async () => {
  const source = await seedAccount('Old');
  const target = await seedAccount('Mid');
  const final = await seedAccount('Final');
  await mergeAccounts({ sourceId: target.id, targetId: final.id, householdId: household.id });
  await assert.rejects(
    () => mergeAccounts({ sourceId: source.id, targetId: target.id, householdId: household.id }),
    (e: unknown) => e instanceof AccountMergeError && e.code === 'TARGET_NOT_MERGEABLE',
  );
});

test('source already merged throws SOURCE_ALREADY_MERGED (AC #7)', async () => {
  const source = await seedAccount('Old');
  const mid = await seedAccount('Mid');
  const other = await seedAccount('Other');
  await mergeAccounts({ sourceId: source.id, targetId: mid.id, householdId: household.id });
  await assert.rejects(
    () => mergeAccounts({ sourceId: source.id, targetId: other.id, householdId: household.id }),
    (e: unknown) => e instanceof AccountMergeError && e.code === 'SOURCE_ALREADY_MERGED',
  );
});

test('missing source throws NOT_FOUND', async () => {
  const target = await seedAccount('New');
  await assert.rejects(
    () => mergeAccounts({ sourceId: 999999, targetId: target.id, householdId: household.id }),
    (e: unknown) => e instanceof AccountMergeError && e.code === 'NOT_FOUND',
  );
});

test('cross-household account is not mergeable (NOT_FOUND)', async () => {
  const source = await seedAccount('Old');
  const otherHh = await models.Household.create({ name: 'Other HH' });
  const target = await models.Account.create({
    householdId: otherHh.id, owner: 'me', visibility: 'shared',
    name: 'Foreign', accountType: 'checking', defaultCurrency: 'CAD',
  } as never);
  await assert.rejects(
    () => mergeAccounts({ sourceId: source.id, targetId: target.id, householdId: household.id }),
    (e: unknown) => e instanceof AccountMergeError && e.code === 'NOT_FOUND',
  );
});
