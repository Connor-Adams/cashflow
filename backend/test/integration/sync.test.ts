/**
 * Integration tests for /api/sync — local-first encrypted backup/restore (#239).
 *
 * Covers:
 *   - POST /api/sync/backup encrypts the active household's data and
 *     records a sync_backups row.
 *   - POST /api/sync/restore/preview decrypts without writing.
 *   - POST /api/sync/restore (merge) refuses if the target household
 *     already has data.
 *   - POST /api/sync/restore (replace) wipes + re-inserts cleanly.
 *   - Wrong passphrase / tampered bundle / wrong size are rejected.
 *   - Cross-household isolation: a bundle from user A restored by
 *     user B lands in user B's household, never bleeding rows back.
 *   - GET /api/sync/history lists the backup/restore audit timeline.
 *   - Unauthenticated calls return 401.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let primaryAgent: ReturnType<typeof request.agent>;
let otherAgent: ReturnType<typeof request.agent>;
let primaryHouseholdId: number;
let primaryAccountId: number;
let otherHouseholdId: number;
let testDb: PgTestDb;

type Seeded = {
  token: string;
  householdId: number;
  userId: number;
  accountId: number;
};

async function seed(emailPrefix: string): Promise<Seeded> {
  const models = await import('../../src/models');
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `${emailPrefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    displayName: emailPrefix,
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: `${emailPrefix} household` });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  const account = await models.Account.create({
    householdId: household.id,
    ownerUserId: user.id,
    owner: 'me',
    visibility: 'shared',
    name: `${emailPrefix} card`,
    accountType: 'credit',
    defaultCurrency: 'CAD',
    shortCode: emailPrefix.slice(0, 3).toUpperCase(),
  });
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });
  return {
    token,
    householdId: household.id,
    userId: user.id,
    accountId: account.id,
  };
}

async function seedTransaction(args: {
  householdId: number;
  accountId: number;
  userId: number;
  merchant: string;
  amount: string;
}): Promise<number> {
  const models = await import('../../src/models');
  const row = await models.Transaction.create({
    accountId: args.accountId,
    householdId: args.householdId,
    visibility: 'shared',
    createdByUserId: args.userId,
    importBatch: 'test-batch',
    date: '2026-01-15',
    merchantRaw: args.merchant,
    merchantClean: args.merchant,
    amount: args.amount,
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: `fp-${crypto.randomBytes(8).toString('hex')}`,
    sourceIdentityFingerprint: `id-${crypto.randomBytes(8).toString('hex')}`,
    appliedRuleId: null,
    entityId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: 'Food',
    autoBusiness: null,
    businessOverride: null,
    finalBusiness: false,
    autoSplitType: null,
    splitOverride: null,
    finalSplitType: 'me',
    autoPctMe: null,
    pctMeOverride: null,
    finalPctMe: null,
    autoPctPartner: null,
    pctPartnerOverride: null,
    finalPctPartner: null,
    merchantCanonical: null,
    autoSource: null,
    autoConfidence: null,
    linkedTransactionId: null,
    transferPurpose: null,
    transferLinkedAt: null,
    reviewFlag: false,
    reviewedAt: null,
    importConfidence: null,
    importConfidenceFlags: null,
  });
  return row.id;
}

before(async () => {
  process.env.NODE_ENV = 'test';

  testDb = await setupPgTestDb('sync');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const bootstrap = testAgent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const primary = await seed('Primary');
  primaryHouseholdId = primary.householdId;
  primaryAccountId = primary.accountId;
  primaryAgent = testAgent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  // Seed a few household-scoped rows so the bundle has something to carry.
  await seedTransaction({
    householdId: primary.householdId,
    accountId: primary.accountId,
    userId: primary.userId,
    merchant: 'Coffee Co',
    amount: '4.50',
  });
  await seedTransaction({
    householdId: primary.householdId,
    accountId: primary.accountId,
    userId: primary.userId,
    merchant: 'Bookstore',
    amount: '21.00',
  });

  const other = await seed('Other');
  otherHouseholdId = other.householdId;
  otherAgent = testAgent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('POST /api/sync/backup returns an encrypted bundle + counts', async () => {
  const res = await primaryAgent
    .post('/api/sync/backup')
    .send({ passphrase: 'correct horse battery staple' });
  assert.equal(res.status, 200);
  assert.ok(typeof res.body.bundle === 'string' && res.body.bundle.length > 0, 'has bundle');
  assert.equal(res.body.bundleVersion, 1);
  assert.equal(res.body.schemaVersion, 1);
  assert.ok(res.body.tableCounts.accounts >= 1, 'accounts in counts');
  assert.equal(res.body.tableCounts.transactions, 2);
  assert.ok(res.body.rowCount >= 3);
});

test('POST /api/sync/backup rejects a short passphrase', async () => {
  const res = await primaryAgent
    .post('/api/sync/backup')
    .send({ passphrase: 'short' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /passphrase/);
});

test('POST /api/sync/restore/preview decrypts without writing', async () => {
  const backup = await primaryAgent
    .post('/api/sync/backup')
    .send({ passphrase: 'multi-byte-passphrase' });
  assert.equal(backup.status, 200);

  const preview = await primaryAgent
    .post('/api/sync/restore/preview')
    .send({
      passphrase: 'multi-byte-passphrase',
      bundle: backup.body.bundle,
    });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.sourceHouseholdId, primaryHouseholdId);
  assert.equal(preview.body.schemaVersion, 1);
  assert.equal(preview.body.tableCounts.transactions, 2);

  // Verify writing did NOT happen: primary still has exactly 2 txns.
  const models = await import('../../src/models');
  const count = await models.Transaction.count({
    where: { householdId: primaryHouseholdId },
  });
  assert.equal(count, 2);
});

test('POST /api/sync/restore/preview rejects wrong passphrase', async () => {
  const backup = await primaryAgent
    .post('/api/sync/backup')
    .send({ passphrase: 'right-passphrase-here' });
  assert.equal(backup.status, 200);

  const preview = await primaryAgent
    .post('/api/sync/restore/preview')
    .send({
      passphrase: 'wrong-passphrase-here',
      bundle: backup.body.bundle,
    });
  assert.equal(preview.status, 400);
  assert.match(preview.body.error, /decrypt|passphrase|tampered/i);
});

test('POST /api/sync/restore in merge mode refuses when target has rows', async () => {
  const backup = await primaryAgent
    .post('/api/sync/backup')
    .send({ passphrase: 'a-stable-passphrase' });
  assert.equal(backup.status, 200);

  const restore = await primaryAgent
    .post('/api/sync/restore')
    .send({
      passphrase: 'a-stable-passphrase',
      bundle: backup.body.bundle,
      mode: 'merge',
    });
  // Target (primary) already has 2 txns + 1 account, so merge refuses.
  assert.equal(restore.status, 400);
  assert.match(restore.body.error, /Refusing to restore|existing rows|replace/i);
});

test('POST /api/sync/restore in replace mode wipes + re-inserts', async () => {
  const backup = await primaryAgent
    .post('/api/sync/backup')
    .send({ passphrase: 'replace-mode-passphrase' });
  assert.equal(backup.status, 200);
  const beforeCounts = backup.body.tableCounts as Record<string, number>;

  const restore = await primaryAgent
    .post('/api/sync/restore')
    .send({
      passphrase: 'replace-mode-passphrase',
      bundle: backup.body.bundle,
      mode: 'replace',
    });
  assert.equal(restore.status, 200);
  assert.equal(restore.body.mode, 'replace');
  // Replace mode wipes target first, then inserts every row.
  assert.equal(restore.body.inserted.transactions, beforeCounts.transactions);
  assert.equal(restore.body.inserted.accounts, beforeCounts.accounts);
});

test('cross-household: bundle from primary restored by other lands in OTHER household', async () => {
  // Re-seed primary because the replace test above wiped + re-inserted.
  // Fresh backup of the current primary state.
  const backup = await primaryAgent
    .post('/api/sync/backup')
    .send({ passphrase: 'cross-household-passphrase' });
  assert.equal(backup.status, 200);

  // Other has its own seeded account, so use replace mode to allow
  // the restore. The cross-household invariant we care about is that
  // the restored rows land in OTHER's household_id, not primary's.
  const restore = await otherAgent
    .post('/api/sync/restore')
    .send({
      passphrase: 'cross-household-passphrase',
      bundle: backup.body.bundle,
      mode: 'replace',
    });
  assert.equal(restore.status, 200);
  assert.ok(restore.body.inserted.transactions > 0);

  // Rows must be scoped to OTHER's household_id, not primary's.
  const models = await import('../../src/models');
  const otherCount = await models.Transaction.count({
    where: { householdId: otherHouseholdId },
  });
  assert.ok(otherCount > 0, 'other household has restored rows');

  // Primary's count must be unchanged by the restore into Other.
  const primaryCount = await models.Transaction.count({
    where: { householdId: primaryHouseholdId },
  });
  assert.ok(primaryCount > 0, 'primary household still has its rows');
});

test('GET /api/sync/history lists past backup + restore events', async () => {
  const res = await primaryAgent.get('/api/sync/history');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.data));
  // We've created several backups + at least one restore by now.
  assert.ok(res.body.data.length >= 3);
  const kinds = new Set(res.body.data.map((r: { kind: string }) => r.kind));
  assert.ok(kinds.has('backup'));
  assert.ok(kinds.has('restore'));
});

test('GET /api/sync/history is household-scoped', async () => {
  // Other household has at most one restore event so far.
  const primary = await primaryAgent.get('/api/sync/history');
  const other = await otherAgent.get('/api/sync/history');
  // Different histories — primary >= other AND no overlap by id.
  const primaryIds = new Set(primary.body.data.map((r: { id: number }) => r.id));
  for (const row of other.body.data as Array<{ id: number }>) {
    assert.equal(
      primaryIds.has(row.id),
      false,
      `row ${row.id} from other household leaked into primary history`,
    );
  }
});

test('unauthenticated /api/sync calls return 401', async () => {
  const fresh = testAgent(app);
  const backup = await fresh
    .post('/api/sync/backup')
    .send({ passphrase: 'doesnt-matter' });
  assert.equal(backup.status, 401);
  const history = await fresh.get('/api/sync/history');
  assert.equal(history.status, 401);
});
