/**
 * Integration tests for /api/monthly-close (issue #227).
 *
 * Pattern mirrors `plannedEvents.test.ts`: bootstrap a superadmin, then
 * seed two non-superadmin households (Primary, Other) so cross-household
 * isolation is exercised via real session cookies.
 *
 * The non-superadmin agent is REQUIRED: the route uses `householdWhere`,
 * which scopes by `household.id` only for non-superadmins. Tests that
 * write Transactions for the unreviewed-count critical-items check must
 * set either `visibility: 'shared'` or `createdByUserId: user.id` (or
 * both) — otherwise the visible-transaction predicate hides the rows
 * we just seeded.
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
let primaryUserId: number;
let primaryContactId: number;
let otherAgent: ReturnType<typeof request.agent>;
let otherHouseholdId: number;
let otherAccountId: number;
let testDb: PgTestDb;

type Seeded = {
  token: string;
  householdId: number;
  userId: number;
  accountId: number;
  contactId: number;
};

async function seed(emailPrefix: string, contactName: string): Promise<Seeded> {
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
  const household = await models.Household.create({
    name: `${emailPrefix} household`,
  });
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
    name: `${emailPrefix} chequing`,
    accountType: 'chequing',
    defaultCurrency: 'CAD',
    shortCode: emailPrefix.slice(0, 3).toUpperCase(),
  });
  const contact = await models.Contact.create({
    householdId: household.id,
    name: contactName,
    notes: null,
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
    contactId: contact.id,
  };
}

async function createTxn(seed: {
  householdId: number;
  accountId: number;
  userId: number;
  date: string;
  amount: number;
  reviewFlag?: boolean;
}): Promise<number> {
  const models = await import('../../src/models');
  const row = await models.Transaction.create({
    accountId: seed.accountId,
    householdId: seed.householdId,
    // visibility:'shared' so the householdWhere predicate (which collapses
    // to {householdId} for non-superadmin) matches without needing the
    // visibleTransactionWhere visibility OR predicate.
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'monthly-close-test',
    date: seed.date,
    merchantRaw: 'Test Merchant',
    merchantClean: 'Test Merchant',
    merchantCanonical: null,
    amount: seed.amount.toFixed(4),
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
    myShareAmount: String(seed.amount),
    partnerShareAmount: '0',
    businessAmount: '0',
    txnType: 'purchase',
    autoSource: null,
    autoConfidence: null,
    linkedTransactionId: null,
    isRecurring: false,
    reviewFlag: seed.reviewFlag ?? false,
    reviewedAt: null,
    createdByUserId: seed.userId,
  });
  return row.id;
}

before(async () => {
  process.env.NODE_ENV = 'test';

  testDb = await setupPgTestDb('monthly_close');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const bootstrap = request.agent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const primary = await seed('Primary', 'Primary Partner');
  primaryHouseholdId = primary.householdId;
  primaryAccountId = primary.accountId;
  primaryUserId = primary.userId;
  primaryContactId = primary.contactId;
  primaryAgent = request.agent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('Other', 'Other Partner');
  otherHouseholdId = other.householdId;
  otherAccountId = other.accountId;
  otherAgent = request.agent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// ---- GET /:periodMonth on a fresh household --------------------------

test('GET /:periodMonth returns null period + empty tasks before start', async () => {
  const res = await primaryAgent.get('/api/monthly-close/2026-04');
  assert.equal(res.status, 200);
  assert.equal(res.body.period, null);
  assert.deepEqual(res.body.tasks, []);
  // Critical detector still runs and produces zero counts in a clean household.
  assert.equal(res.body.critical.counts.unreviewedTransactions, 0);
  assert.equal(res.body.critical.counts.outstandingPartnerBuckets, 0);
});

test('GET /:periodMonth rejects malformed period months', async () => {
  const res = await primaryAgent.get('/api/monthly-close/not-a-month');
  assert.equal(res.status, 400);
});

// ---- POST /:periodMonth/start ---------------------------------------

test('POST /:periodMonth/start creates a period with the default checklist', async () => {
  const res = await primaryAgent.post('/api/monthly-close/2026-04/start').send({});
  assert.equal(res.status, 201);
  assert.equal(res.body.period.periodMonth, '2026-04');
  assert.equal(res.body.period.status, 'open');
  assert.ok(res.body.period.openedAt);
  assert.equal(res.body.period.closedAt, null);
  assert.equal(res.body.period.householdId, primaryHouseholdId);
  assert.equal(res.body.period.userId, primaryUserId);
  // Default checklist has 7 entries — see DEFAULT_MONTHLY_CLOSE_TASKS.
  const tasks = res.body.tasks as Array<{
    taskKey: string;
    sortOrder: number;
    isComplete: boolean;
  }>;
  assert.equal(tasks.length, 7);
  for (let i = 1; i < tasks.length; i++) {
    assert.ok(
      tasks[i].sortOrder > tasks[i - 1].sortOrder,
      `tasks must be ordered by sortOrder ASC`,
    );
  }
  // Every task starts incomplete.
  for (const t of tasks) assert.equal(t.isComplete, false);
});

test('POST /:periodMonth/start is idempotent — second call returns same period id', async () => {
  const first = await primaryAgent.post('/api/monthly-close/2026-04/start').send({});
  const second = await primaryAgent.post('/api/monthly-close/2026-04/start').send({});
  assert.equal(second.status, 201);
  assert.equal(second.body.period.id, first.body.period.id);
  // No duplicate task rows.
  assert.equal(second.body.tasks.length, 7);
});

test('POST /:periodMonth/start rejects malformed period month', async () => {
  const res = await primaryAgent.post('/api/monthly-close/2026-99/start').send({});
  assert.equal(res.status, 400);
});

// ---- GET /:periodMonth after start ----------------------------------

test('GET /:periodMonth returns the seeded period + tasks', async () => {
  const res = await primaryAgent.get('/api/monthly-close/2026-04');
  assert.equal(res.status, 200);
  assert.equal(res.body.period.periodMonth, '2026-04');
  assert.equal(res.body.tasks.length, 7);
});

// ---- PATCH /:periodMonth/tasks/:taskKey -----------------------------

test('PATCH /:periodMonth/tasks/:taskKey marks a task complete', async () => {
  const res = await primaryAgent
    .patch('/api/monthly-close/2026-04/tasks/imports')
    .send({ isComplete: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.isComplete, true);
  assert.ok(res.body.completedAt);
  assert.equal(res.body.completedByUserId, primaryUserId);
});

test('PATCH /:periodMonth/tasks/:taskKey can toggle back to incomplete', async () => {
  const res = await primaryAgent
    .patch('/api/monthly-close/2026-04/tasks/imports')
    .send({ isComplete: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.isComplete, false);
  assert.equal(res.body.completedAt, null);
  assert.equal(res.body.completedByUserId, null);
});

test('PATCH /:periodMonth/tasks/:taskKey persists optional notes', async () => {
  const res = await primaryAgent
    .patch('/api/monthly-close/2026-04/tasks/imports')
    .send({ notes: 'CIBC + RBC pulled' });
  assert.equal(res.status, 200);
  assert.equal(res.body.notes, 'CIBC + RBC pulled');
});

test('PATCH rejects an unknown task key', async () => {
  const res = await primaryAgent
    .patch('/api/monthly-close/2026-04/tasks/bogus')
    .send({ isComplete: true });
  assert.equal(res.status, 400);
});

test('PATCH 404s before the period exists', async () => {
  const res = await primaryAgent
    .patch('/api/monthly-close/2025-01/tasks/imports')
    .send({ isComplete: true });
  assert.equal(res.status, 404);
});

// ---- POST /:periodMonth/close with critical items -----------------

test('POST /close blocks when reviewFlag transactions exist (with critical warning)', async () => {
  // Seed an unreviewed transaction inside the period.
  await createTxn({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    userId: primaryUserId,
    date: '2026-04-15',
    amount: -42,
    reviewFlag: true,
  });

  const res = await primaryAgent.post('/api/monthly-close/2026-04/close').send({});
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'critical_items');
  assert.equal(res.body.critical.counts.unreviewedTransactions, 1);
  assert.ok(res.body.critical.reasons.includes('unreviewed_transactions'));
});

test('POST /close with force=true closes despite critical items', async () => {
  const res = await primaryAgent
    .post('/api/monthly-close/2026-04/close')
    .send({ force: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.period.status, 'closed');
  assert.ok(res.body.period.closedAt);
});

// ---- Closed-period invariant ---------------------------------------

test('PATCH on a closed period is rejected with 409', async () => {
  const res = await primaryAgent
    .patch('/api/monthly-close/2026-04/tasks/review_inbox')
    .send({ isComplete: true });
  assert.equal(res.status, 409);
});

// ---- POST /:periodMonth/reopen --------------------------------------

test('POST /:periodMonth/reopen flips status back to open', async () => {
  const res = await primaryAgent
    .post('/api/monthly-close/2026-04/reopen')
    .send();
  assert.equal(res.status, 200);
  assert.equal(res.body.period.status, 'open');
  assert.equal(res.body.period.closedAt, null);
});

test('POST /:periodMonth/reopen is idempotent on an already-open period', async () => {
  const res = await primaryAgent
    .post('/api/monthly-close/2026-04/reopen')
    .send();
  assert.equal(res.status, 200);
  assert.equal(res.body.period.status, 'open');
});

// ---- GET / list ----------------------------------------------------

test('GET / returns periods sorted newest first', async () => {
  await primaryAgent.post('/api/monthly-close/2026-02/start').send({});
  await primaryAgent.post('/api/monthly-close/2026-03/start').send({});

  const res = await primaryAgent.get('/api/monthly-close');
  assert.equal(res.status, 200);
  const months = (res.body.data as Array<{ periodMonth: string }>).map(
    (r) => r.periodMonth,
  );
  // 2026-04, 2026-03, 2026-02 should all be present in descending order.
  assert.ok(months.length >= 3);
  for (let i = 1; i < months.length; i++) {
    assert.ok(
      months[i - 1] >= months[i],
      `expected ${months[i - 1]} >= ${months[i]}`,
    );
  }
});

// ---- Cross-household isolation -------------------------------------

test('Other household cannot see Primary periods (and vice versa)', async () => {
  // Other starts its own period to make sure their list isn't empty by accident.
  const otherStarted = await otherAgent
    .post('/api/monthly-close/2026-04/start')
    .send({});
  assert.equal(otherStarted.status, 201);
  const otherPeriodId = otherStarted.body.period.id;

  // Other's list does NOT include Primary's row (and vice versa).
  const otherList = await otherAgent.get('/api/monthly-close');
  assert.equal(otherList.status, 200);
  const otherIds = (otherList.body.data as Array<{ id: number }>).map(
    (r) => r.id,
  );
  // Primary's 2026-04 period id ≠ Other's 2026-04 period id, even though
  // they happen to share the same period_month.
  const primaryGet = await primaryAgent.get('/api/monthly-close/2026-04');
  assert.equal(primaryGet.status, 200);
  const primaryPeriodId = primaryGet.body.period.id as number;
  assert.notEqual(primaryPeriodId, otherPeriodId);
  assert.ok(otherIds.includes(otherPeriodId));
  assert.ok(!otherIds.includes(primaryPeriodId));

  // Defensive sanity — the two seeded households really are different rows.
  assert.notEqual(primaryHouseholdId, otherHouseholdId);
  assert.notEqual(primaryAccountId, otherAccountId);
  assert.ok(primaryContactId);
});

// ---- Unauthenticated request rejected ------------------------------

test('Unauthenticated GET is rejected with 401', async () => {
  const res = await request(app).get('/api/monthly-close');
  assert.equal(res.status, 401);
});
