/**
 * Integration test for loadRelationshipCandidates. Runs in isolation
 * (`yarn test:integration`) so DATABASE_PATH is set before any Sequelize
 * import.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-integration-load-rel-candidates.sqlite');

let loadRelationshipCandidates: typeof import('../../src/import/enrichment/loaders').loadRelationshipCandidates;
let Transaction: typeof import('../../src/models').Transaction;
let Account: typeof import('../../src/models').Account;
let User: typeof import('../../src/models').User;
let sequelize: typeof import('../../src/models').sequelize;

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';

  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: {
      ...process.env,
      DATABASE_PATH: dbPath,
      NODE_ENV: 'development',
    },
    stdio: 'pipe',
  });

  const models = await import('../../src/models');
  Transaction = models.Transaction;
  Account = models.Account;
  User = models.User;
  sequelize = models.sequelize;
  const loaders = await import('../../src/import/enrichment/loaders');
  loadRelationshipCandidates = loaders.loadRelationshipCandidates;
});

after(async () => {
  if (sequelize) await sequelize.close();
  if (fs.existsSync(dbPath)) {
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  }
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
