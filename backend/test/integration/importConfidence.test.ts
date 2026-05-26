/**
 * Integration tests for the import-confidence API surface (#214).
 *
 *   GET  /api/import/health?currency=CAD
 *   GET  /api/import/history             (now includes per-batch counts)
 *   GET  /api/transactions?confidenceFlag=missing_category
 *   GET  /api/transactions?importConfidence=needs_review
 *
 * Mirrors the businessTax / receiptCompleteness pattern: spin up a Postgres
 * test DB, register a superadmin, seed two non-superadmin households, drive
 * the API with real session cookies so visibility + scope are exercised
 * authentically.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let primaryAgent: ReturnType<typeof request.agent>;
let primaryHouseholdId: number;
let primaryAccountId: number;
let otherAgent: ReturnType<typeof request.agent>;
let otherHouseholdId: number;
let otherAccountId: number;
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

type ConfidenceTx = {
  householdId: number;
  accountId: number;
  date?: string;
  importBatch?: string;
  amount?: number;
  currency?: string;
  category?: string | null;
  importConfidence?: 'clean' | 'needs_review' | null;
  flags?: string[] | null;
  reviewFlag?: boolean;
  userId?: number;
};

async function createConfidenceTx(opts: ConfidenceTx): Promise<number> {
  const models = await import('../../src/models');
  const flagsJson =
    opts.flags && opts.flags.length > 0 ? JSON.stringify(opts.flags) : null;
  const row = await models.Transaction.create({
    accountId: opts.accountId,
    householdId: opts.householdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: opts.importBatch ?? 'conf-test',
    date: opts.date ?? '2026-03-01',
    merchantRaw: 'Conf Merchant',
    merchantClean: 'Conf Merchant',
    amount: (opts.amount ?? -25).toFixed(4),
    currency: opts.currency ?? 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: opts.category ?? null,
    categoryOverride: null,
    finalCategory: opts.category ?? null,
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
    importConfidenceFlags: flagsJson,
  });
  return row.id;
}

before(async () => {
  testDb = await setupPgTestDb('importconf');
  const mod = await import('../../src/app.js');
  app = mod.default;

  const bootstrap = request.agent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin-importconf@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const primary = await seed('PrimaryIC');
  primaryHouseholdId = primary.householdId;
  primaryAccountId = primary.accountId;
  primaryAgent = request.agent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('OtherIC');
  otherHouseholdId = other.householdId;
  otherAccountId = other.accountId;
  otherAgent = request.agent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// ---- GET /api/import/health --------------------------------------------

test('GET /api/import/health reports clean / needs_review / unknown counts', async () => {
  // Three classified rows in the primary household:
  //  - clean
  //  - needs_review with missing_category
  //  - needs_review with missing_split + needs_review tokens
  // Plus one legacy 'unknown' row (NULL state).
  await createConfidenceTx({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    importBatch: 'b-health-1',
    importConfidence: 'clean',
    flags: null,
    category: 'Dining',
  });
  await createConfidenceTx({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    importBatch: 'b-health-1',
    importConfidence: 'needs_review',
    flags: ['missing_category', 'needs_review'],
    reviewFlag: true,
    category: null,
  });
  await createConfidenceTx({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    importBatch: 'b-health-2',
    importConfidence: 'needs_review',
    flags: ['missing_split', 'needs_review'],
    reviewFlag: true,
    category: 'Dining',
  });
  await createConfidenceTx({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    importBatch: 'b-health-legacy',
    importConfidence: null,
    flags: null,
    category: 'Dining',
  });

  const res = await primaryAgent.get('/api/import/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 4);
  assert.equal(res.body.clean, 1);
  assert.equal(res.body.needsReview, 2);
  assert.equal(res.body.unknown, 1);
  // 1 / (1 + 2) ≈ 0.333…
  assert.ok(res.body.cleanPercent > 0.33 && res.body.cleanPercent < 0.34);
  // Flag counter sees: needs_review×2, missing_category×1, missing_split×1
  assert.equal(res.body.byFlag.needs_review, 2);
  assert.equal(res.body.byFlag.missing_category, 1);
  assert.equal(res.body.byFlag.missing_split, 1);
});

test('GET /api/import/health is scoped to the active household', async () => {
  // Seed the OTHER household with a clean row. The primary household snapshot
  // must not see it — basic cross-household isolation guard.
  await createConfidenceTx({
    householdId: otherHouseholdId,
    accountId: otherAccountId,
    importBatch: 'b-other',
    importConfidence: 'clean',
    flags: null,
    category: 'Other',
  });
  const primaryRes = await primaryAgent.get('/api/import/health');
  const otherRes = await otherAgent.get('/api/import/health');
  assert.equal(primaryRes.status, 200);
  assert.equal(otherRes.status, 200);
  assert.equal(otherRes.body.total, 1);
  assert.equal(otherRes.body.clean, 1);
  assert.equal(otherRes.body.needsReview, 0);
  // Primary still has its 4 from the prior test — confirming isolation.
  assert.equal(primaryRes.body.total, 4);
});

test('GET /api/import/health currency filter narrows the snapshot', async () => {
  await createConfidenceTx({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    importBatch: 'b-usd',
    importConfidence: 'clean',
    currency: 'USD',
    category: 'USD Spend',
  });
  const cad = await primaryAgent.get('/api/import/health?currency=CAD');
  const usd = await primaryAgent.get('/api/import/health?currency=USD');
  assert.equal(cad.body.currency, 'CAD');
  assert.equal(usd.body.currency, 'USD');
  // CAD scope still 4 from before; USD scope is just the new row.
  assert.equal(cad.body.total, 4);
  assert.equal(usd.body.total, 1);
  assert.equal(usd.body.clean, 1);
});

// ---- GET /api/import/history (extended with per-batch counts) ----------

test('GET /api/import/history extends rows with clean/needsReview counts', async () => {
  // Create an ImportHistory row for one of the batches we've already seeded.
  const models = await import('../../src/models');
  await models.ImportHistory.create({
    fileName: 'b-health-1.csv',
    filePathSafe: 'b-health-1.csv',
    contentHash: 'hash-1',
    batchLabel: 'b-health-1',
    status: 'success',
    rowCount: 2,
    errorMessage: null,
    startedAt: new Date('2026-03-01T00:00:00Z'),
    finishedAt: new Date('2026-03-01T00:00:01Z'),
    householdId: primaryHouseholdId,
    createdByUserId: null,
  });

  const res = await primaryAgent.get('/api/import/history');
  assert.equal(res.status, 200);
  const row = (res.body as Array<{
    batchLabel: string;
    cleanCount: number;
    needsReviewCount: number;
  }>).find((r) => r.batchLabel === 'b-health-1');
  assert.ok(row, 'expected the b-health-1 row');
  assert.equal(row.cleanCount, 1);
  assert.equal(row.needsReviewCount, 1);
});

// ---- GET /api/transactions filter --------------------------------------

test('GET /api/transactions?importConfidence=needs_review filters by state', async () => {
  const res = await primaryAgent.get(
    '/api/transactions?importConfidence=needs_review&pageSize=50',
  );
  assert.equal(res.status, 200);
  type Row = { id: number; importConfidence: string | null };
  const rows = (res.body.data ?? []) as Row[];
  assert.ok(rows.length >= 2);
  for (const r of rows) {
    assert.equal(r.importConfidence, 'needs_review');
  }
});

test('GET /api/transactions?confidenceFlag=missing_category filters by flag', async () => {
  const res = await primaryAgent.get(
    '/api/transactions?confidenceFlag=missing_category&pageSize=50',
  );
  assert.equal(res.status, 200);
  type Row = { id: number; importConfidenceFlags: string | null };
  const rows = (res.body.data ?? []) as Row[];
  assert.ok(rows.length >= 1);
  for (const r of rows) {
    assert.ok(
      r.importConfidenceFlags?.includes('"missing_category"'),
      `expected missing_category in flags: ${r.importConfidenceFlags}`,
    );
  }
});

test('GET /api/transactions?confidenceFlag rejects junk tokens silently', async () => {
  // The filter strips non [a-z_] chars; a bogus token simply matches no row.
  const res = await primaryAgent.get(
    '/api/transactions?confidenceFlag=bogus_flag&pageSize=50',
  );
  assert.equal(res.status, 200);
  type Row = { id: number };
  const rows = (res.body.data ?? []) as Row[];
  assert.equal(rows.length, 0);
});
