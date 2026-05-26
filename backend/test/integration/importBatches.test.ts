/**
 * Integration tests for the import batch manager surface (#231).
 *
 *   GET  /api/import/batches?limit=&offset=
 *   GET  /api/import/batches/:id
 *
 * Covers:
 *   - Listing batches for the active household, descending startedAt.
 *   - Per-batch confidence counts (cleanCount / needsReviewCount).
 *   - Structured account / profile / inserted / skipped / row-error metadata
 *     captured at import time.
 *   - Batch detail returns the parent account snapshot.
 *   - Cross-household isolation: other-household batches stay invisible.
 *   - 404 for a missing batch id, 400 for an invalid id.
 *   - importCsvFile persists the new metadata end-to-end.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let primaryAgent: ReturnType<typeof request.agent>;
let primaryHouseholdId: number;
let primaryUserId: number;
let primaryAccountId: number;
let otherAgent: ReturnType<typeof request.agent>;
let otherHouseholdId: number;
let otherUserId: number;
let testDb: PgTestDb;

type Seeded = { token: string; householdId: number; userId: number; accountId: number };

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
  return { token, householdId: household.id, userId: user.id, accountId: account.id };
}

type BatchTx = {
  householdId: number;
  accountId: number;
  importBatch: string;
  importConfidence?: 'clean' | 'needs_review' | null;
  reviewFlag?: boolean;
  userId?: number;
};

async function seedBatchTransaction(opts: BatchTx): Promise<number> {
  const models = await import('../../src/models');
  const row = await models.Transaction.create({
    accountId: opts.accountId,
    householdId: opts.householdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: opts.importBatch,
    date: '2026-03-01',
    merchantRaw: 'Batch Merchant',
    merchantClean: 'Batch Merchant',
    amount: '-25.0000',
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: null,
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
    reviewFlag: opts.reviewFlag ?? false,
    reviewedAt: null,
    createdByUserId: opts.userId ?? null,
    importConfidence: opts.importConfidence ?? null,
    importConfidenceFlags: null,
  });
  return row.id;
}

async function seedImportHistory(opts: {
  householdId: number;
  userId: number;
  accountId: number | null;
  batchLabel: string;
  profileId: string | null;
  inserted: number | null;
  skipped: number | null;
  rowErrors: number | null;
  status?: string;
  startedAt?: Date;
}): Promise<number> {
  const models = await import('../../src/models');
  const row = await models.ImportHistory.create({
    fileName: `${opts.batchLabel}.csv`,
    filePathSafe: `${opts.batchLabel}.csv`,
    contentHash: crypto.randomBytes(16).toString('hex'),
    batchLabel: opts.batchLabel,
    status: opts.status ?? 'success',
    rowCount: opts.inserted,
    errorMessage: null,
    startedAt: opts.startedAt ?? new Date('2026-03-01T00:00:00Z'),
    finishedAt: new Date('2026-03-01T00:00:05Z'),
    householdId: opts.householdId,
    createdByUserId: opts.userId,
    accountId: opts.accountId,
    profileId: opts.profileId,
    insertedCount: opts.inserted,
    skippedDuplicateCount: opts.skipped,
    rowErrorsCount: opts.rowErrors,
  });
  return row.id;
}

before(async () => {
  testDb = await setupPgTestDb('importbatches');
  const mod = await import('../../src/app.js');
  app = mod.default;

  const bootstrap = request.agent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin-importbatches@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const primary = await seed('PrimaryIB');
  primaryHouseholdId = primary.householdId;
  primaryUserId = primary.userId;
  primaryAccountId = primary.accountId;
  primaryAgent = request.agent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('OtherIB');
  otherHouseholdId = other.householdId;
  otherUserId = other.userId;
  otherAgent = request.agent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/import/batches lists batches with structured metadata', async () => {
  await seedImportHistory({
    householdId: primaryHouseholdId,
    userId: primaryUserId,
    accountId: primaryAccountId,
    batchLabel: 'batch-list-1',
    profileId: 'generic_simple',
    inserted: 7,
    skipped: 1,
    rowErrors: 0,
    startedAt: new Date('2026-03-02T00:00:00Z'),
  });
  await seedImportHistory({
    householdId: primaryHouseholdId,
    userId: primaryUserId,
    accountId: primaryAccountId,
    batchLabel: 'batch-list-2',
    profileId: 'generic_passthrough',
    inserted: 3,
    skipped: 2,
    rowErrors: 1,
    status: 'partial',
    startedAt: new Date('2026-03-03T00:00:00Z'),
  });
  // Backfill matching transactions so the confidence breakdown is non-zero.
  await seedBatchTransaction({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    importBatch: 'batch-list-1',
    importConfidence: 'clean',
    userId: primaryUserId,
  });
  await seedBatchTransaction({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    importBatch: 'batch-list-1',
    importConfidence: 'needs_review',
    reviewFlag: true,
    userId: primaryUserId,
  });

  const res = await primaryAgent.get('/api/import/batches');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.total, 'number');
  assert.equal(res.body.limit, 50);
  assert.equal(res.body.offset, 0);
  assert.ok(Array.isArray(res.body.batches));

  type Row = {
    id: number;
    batchLabel: string;
    profileId: string | null;
    accountId: number | null;
    insertedCount: number | null;
    skippedDuplicateCount: number | null;
    rowErrorsCount: number | null;
    cleanCount: number;
    needsReviewCount: number;
    startedAt: string;
  };
  const rows = res.body.batches as Row[];
  // batch-list-2 was started later than batch-list-1 so it should come first.
  const labels = rows.map((r) => r.batchLabel);
  const idx1 = labels.indexOf('batch-list-1');
  const idx2 = labels.indexOf('batch-list-2');
  assert.ok(idx2 < idx1, `expected batch-list-2 before batch-list-1: ${labels.join(',')}`);

  const b1 = rows.find((r) => r.batchLabel === 'batch-list-1');
  assert.ok(b1, 'expected batch-list-1');
  assert.equal(b1.profileId, 'generic_simple');
  assert.equal(b1.accountId, primaryAccountId);
  assert.equal(b1.insertedCount, 7);
  assert.equal(b1.skippedDuplicateCount, 1);
  assert.equal(b1.rowErrorsCount, 0);
  assert.equal(b1.cleanCount, 1);
  assert.equal(b1.needsReviewCount, 1);
});

test('GET /api/import/batches respects limit + offset', async () => {
  const page1 = await primaryAgent.get('/api/import/batches?limit=1&offset=0');
  assert.equal(page1.status, 200);
  assert.equal(page1.body.limit, 1);
  assert.equal(page1.body.offset, 0);
  assert.equal(page1.body.batches.length, 1);

  const page2 = await primaryAgent.get('/api/import/batches?limit=1&offset=1');
  assert.equal(page2.status, 200);
  assert.equal(page2.body.offset, 1);
  assert.equal(page2.body.batches.length, 1);
  // Different rows on the two pages.
  assert.notEqual(page1.body.batches[0].id, page2.body.batches[0].id);
});

test('GET /api/import/batches isolates other households', async () => {
  await seedImportHistory({
    householdId: otherHouseholdId,
    userId: otherUserId,
    accountId: null,
    batchLabel: 'other-batch',
    profileId: 'generic_simple',
    inserted: 5,
    skipped: 0,
    rowErrors: 0,
  });
  const res = await primaryAgent.get('/api/import/batches');
  const labels = (res.body.batches as Array<{ batchLabel: string }>).map(
    (r) => r.batchLabel,
  );
  assert.ok(!labels.includes('other-batch'), `primary should not see other-batch: ${labels.join(',')}`);

  const otherRes = await otherAgent.get('/api/import/batches');
  const otherLabels = (otherRes.body.batches as Array<{ batchLabel: string }>).map(
    (r) => r.batchLabel,
  );
  assert.ok(otherLabels.includes('other-batch'));
});

test('GET /api/import/batches/:id returns full detail including account snapshot', async () => {
  const id = await seedImportHistory({
    householdId: primaryHouseholdId,
    userId: primaryUserId,
    accountId: primaryAccountId,
    batchLabel: 'batch-detail-1',
    profileId: 'generic_simple',
    inserted: 10,
    skipped: 3,
    rowErrors: 0,
  });
  await seedBatchTransaction({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    importBatch: 'batch-detail-1',
    importConfidence: 'clean',
    userId: primaryUserId,
  });

  const res = await primaryAgent.get(`/api/import/batches/${id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, id);
  assert.equal(res.body.batchLabel, 'batch-detail-1');
  assert.equal(res.body.profileId, 'generic_simple');
  assert.equal(res.body.insertedCount, 10);
  assert.equal(res.body.skippedDuplicateCount, 3);
  assert.equal(res.body.rowErrorsCount, 0);
  assert.equal(res.body.cleanCount, 1);
  assert.ok(res.body.account, 'expected account snapshot');
  assert.equal(res.body.account.id, primaryAccountId);
  assert.ok(typeof res.body.account.name === 'string');
});

test('GET /api/import/batches/:id returns 404 when missing or other household', async () => {
  const otherBatchId = await seedImportHistory({
    householdId: otherHouseholdId,
    userId: otherUserId,
    accountId: null,
    batchLabel: 'other-detail',
    profileId: null,
    inserted: 1,
    skipped: 0,
    rowErrors: 0,
  });
  // Primary cannot fetch the other household's batch.
  const crossHousehold = await primaryAgent.get(`/api/import/batches/${otherBatchId}`);
  assert.equal(crossHousehold.status, 404);

  // 404 for missing.
  const missing = await primaryAgent.get('/api/import/batches/999999');
  assert.equal(missing.status, 404);
});

test('GET /api/import/batches/:id returns 400 for invalid id', async () => {
  const res = await primaryAgent.get('/api/import/batches/not-a-number');
  assert.equal(res.status, 400);
  assert.ok(res.body.error);
});

test('GET /api/import/batches gracefully handles legacy NULL metadata', async () => {
  // Legacy rows have NULL for accountId/profileId/insertedCount etc. (rows
  // imported before #231 landed). The endpoint must not crash and must
  // serialize the NULLs through unchanged.
  const legacyId = await seedImportHistory({
    householdId: primaryHouseholdId,
    userId: primaryUserId,
    accountId: null,
    batchLabel: 'legacy-batch',
    profileId: null,
    inserted: null,
    skipped: null,
    rowErrors: null,
  });
  const detail = await primaryAgent.get(`/api/import/batches/${legacyId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.accountId, null);
  assert.equal(detail.body.profileId, null);
  assert.equal(detail.body.insertedCount, null);
  assert.equal(detail.body.account, null);
});

test('importCsvFile persists structured batch metadata after a real CSV upload', async () => {
  // End-to-end check that the runImport.ts ImportHistory.create call now
  // captures account/profile/counts. We use the same authed agent + a
  // freshly created account to keep the run hermetic.
  const acc = await primaryAgent.post('/api/accounts').send({
    name: 'IB Upload Account',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  const uploadAccountId = acc.body.id as number;

  const csv =
    'Date,Description,Amount\n2026-04-01,IB One,-7.00\n2026-04-02,IB Two,-8.00\n';
  const upload = await primaryAgent
    .post('/api/import/upload')
    .field('accountId', String(uploadAccountId))
    .field('profileId', 'generic_simple')
    .field('batchLabel', 'ib-real-upload')
    .attach('file', Buffer.from(csv, 'utf8'), {
      filename: 'ib-real.csv',
      contentType: 'text/csv',
    });
  assert.equal(upload.status, 200);
  assert.ok(upload.body.inserted >= 2);

  const list = await primaryAgent.get('/api/import/batches?limit=200');
  assert.equal(list.status, 200);
  type Row = {
    batchLabel: string;
    accountId: number | null;
    profileId: string | null;
    insertedCount: number | null;
  };
  const row = (list.body.batches as Row[]).find((r) => r.batchLabel === 'ib-real-upload');
  assert.ok(row, 'expected the new batch in /api/import/batches');
  assert.equal(row.accountId, uploadAccountId);
  assert.equal(row.profileId, 'generic_simple');
  assert.ok(row.insertedCount && row.insertedCount >= 2);
});
