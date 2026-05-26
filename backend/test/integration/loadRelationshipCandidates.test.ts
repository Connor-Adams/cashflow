/**
 * Integration test for loadRelationshipCandidates. Runs in isolation
 * (`yarn test:integration`) so DATABASE_URL is set before any Sequelize
 * import.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let testDb: PgTestDb;
let loadRelationshipCandidates: typeof import('../../src/import/enrichment/loaders').loadRelationshipCandidates;
let Transaction: typeof import('../../src/models').Transaction;
let Account: typeof import('../../src/models').Account;
let User: typeof import('../../src/models').User;

before(async () => {
  testDb = await setupPgTestDb('load-rel-candidates');

  const models = await import('../../src/models');
  Transaction = models.Transaction;
  Account = models.Account;
  User = models.User;
  const loaders = await import('../../src/import/enrichment/loaders');
  loadRelationshipCandidates = loaders.loadRelationshipCandidates;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('loadRelationshipCandidates(householdId=null) only returns matching-merchant rows within the window', async () => {
  // Seed: one user, one account (no household), three transactions.
  //   (a) matching merchant, inside window  → expected in results
  //   (b) non-matching merchant, inside window → NOT expected
  //   (c) matching merchant, OUTSIDE window  → NOT expected
  const user = await User.create({
    email: 'rel-test@example.com',
    displayName: 'Rel Test',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: '{}',
  });
  const account = await Account.create({
    ownerUserId: user.id,
    name: 'Test Acct',
    owner: 'me',
    householdId: null,
  });
  await Transaction.bulkCreate([
    {
      accountId: account.id,
      householdId: null,
      date: '2026-05-10',
      amount: -25,
      merchantRaw: 'AMAZON.COM',
      merchantClean: 'AMAZON',
      currency: 'USD',
      importBatch: 'test-batch',
      sourceRowFingerprint: 'fp-a',
      sourceIdentityFingerprint: 'id-a',
    },
    {
      accountId: account.id,
      householdId: null,
      date: '2026-05-12',
      amount: -50,
      merchantRaw: 'STARBUCKS',
      merchantClean: 'STARBUCKS',
      currency: 'USD',
      importBatch: 'test-batch',
      sourceRowFingerprint: 'fp-b',
      sourceIdentityFingerprint: 'id-b',
    },
    {
      accountId: account.id,
      householdId: null,
      date: '2026-01-01',
      amount: -25,
      merchantRaw: 'AMAZON.COM',
      merchantClean: 'AMAZON',
      currency: 'USD',
      importBatch: 'test-batch',
      sourceRowFingerprint: 'fp-c',
      sourceIdentityFingerprint: 'id-c',
    },
  ]);

  const candidates = await loadRelationshipCandidates(
    /* householdId */ null,
    /* householdAccountIds */ [account.id],
    /* merchantClean */ 'AMAZON',
    /* date */ '2026-05-15',
    /* refundWindowDays */ 60,
  );

  const merchants = candidates.map((c) => c.merchantClean).sort();
  assert.deepEqual(merchants, ['AMAZON'], 'should only include the matching-merchant row inside the window');
});

test('loadRelationshipCandidates is case-insensitive on merchantClean (aligns with loadRecurringHistory)', async () => {
  // normalizeMerchant preserves the input case, so historical rows can have
  // mixed-case merchant_clean values. The sister function loadRecurringHistory
  // already uses LOWER(...) = LOWER(...); this test locks in the same
  // behaviour here so a refund matched against a lowercase historical row
  // isn't silently dropped.
  const user = await User.create({
    email: 'rel-case@example.com',
    displayName: 'Rel Case',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: '{}',
  });
  const account = await Account.create({
    ownerUserId: user.id,
    name: 'Case Acct',
    owner: 'me',
    householdId: null,
  });
  await Transaction.bulkCreate([
    {
      accountId: account.id,
      householdId: null,
      date: '2026-05-10',
      amount: -42,
      merchantRaw: 'tim hortons',
      merchantClean: 'tim hortons',
      currency: 'CAD',
      importBatch: 'test-case-batch',
      sourceRowFingerprint: 'fp-case-a',
      sourceIdentityFingerprint: 'id-case-a',
    },
  ]);

  const candidates = await loadRelationshipCandidates(
    null,
    [account.id],
    'TIM HORTONS',
    '2026-05-15',
    60,
  );

  assert.equal(candidates.length, 1, 'lowercase historical row should match uppercase query');
  assert.equal(candidates[0].merchantClean, 'tim hortons');
});
