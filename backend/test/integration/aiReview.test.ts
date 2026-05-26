/**
 * Integration tests for /api/ai/review and /api/ai/reviews* (issue #210).
 * Runs in isolation (`yarn test:integration`) against a per-file Postgres
 * database provisioned by setupPgTestDb (sets DATABASE_URL before any
 * Sequelize import).
 *
 * Coverage:
 *  - POST /api/ai/review creates a run with action items
 *  - GET  /api/ai/reviews lists runs newest-first, household-scoped
 *  - GET  /api/ai/reviews/:id returns a run + items
 *  - GET  /api/ai/reviews/:id 404s for another household
 *  - POST /api/ai/reviews/:id/items/:itemId/accept|dismiss flips status
 *  - Validation: bad dates, swapped order, bad currency
 *  - Degrade gracefully when OpenAI is not configured (no key → still 201)
 *  - Action items include rule_suggestion, missing_receipt, subscription,
 *    forecast_warning given seeded fixtures
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let primaryAgent: ReturnType<typeof request.agent>;
let otherAgent: ReturnType<typeof request.agent>;
let primaryHouseholdId: number;
let primaryUserId: number;
let primaryAccountId: number;
let otherHouseholdId: number;
let otherAccountId: number;
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
    name: `${emailPrefix} checking`,
    accountType: 'chequing',
    defaultCurrency: 'CAD',
    shortCode: emailPrefix.slice(0, 3).toUpperCase(),
  });
  const token = crypto.randomBytes(32).toString('hex');
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
  });
  return { token, householdId: household.id, userId: user.id, accountId: account.id };
}

before(async () => {
  process.env.NODE_ENV = 'test';
  // Ensure deterministic path: no OpenAI key configured.
  delete process.env.OPENAI_API_KEY;

  testDb = await setupPgTestDb('ai-review');
  const mod = await import('../../src/app.js');
  app = mod.default;

  // First registered user becomes superadmin — used only to bootstrap.
  const bootstrap = request.agent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const primary = await seed('Primary');
  primaryHouseholdId = primary.householdId;
  primaryUserId = primary.userId;
  primaryAccountId = primary.accountId;
  primaryAgent = request.agent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('Other');
  otherHouseholdId = other.householdId;
  otherAccountId = other.accountId;
  otherAgent = request.agent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);

  // Seed fixtures the runner can pick up.
  const models = await import('../../src/models');

  type TxnSeed = {
    date: string;
    merchantRaw: string;
    merchantClean: string;
    amount: string;
    finalCategory?: string | null;
    reviewedAt?: Date | null;
  };

  async function makeTxn(seed: TxnSeed): Promise<void> {
    await models.Transaction.create({
      householdId: primaryHouseholdId,
      accountId: primaryAccountId,
      visibility: 'shared',
      importBatch: 'ai-review-test',
      sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
      sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
      date: seed.date,
      merchantRaw: seed.merchantRaw,
      merchantClean: seed.merchantClean,
      amount: seed.amount,
      currency: 'CAD',
      finalCategory: seed.finalCategory ?? null,
      finalBusiness: false,
      finalSplitType: 'me',
      txnType: 'purchase',
      myShareAmount: seed.amount,
      partnerShareAmount: '0',
      businessAmount: '0',
      isRecurring: false,
      reviewFlag: false,
      reviewedAt: seed.reviewedAt ?? null,
    } as never);
  }

  // Three near-identical Netflix charges in May → triggers subscription rule.
  for (const day of [3, 10, 17]) {
    await makeTxn({
      date: `2026-05-${String(day).padStart(2, '0')}`,
      merchantClean: 'Netflix',
      merchantRaw: 'NETFLIX.COM',
      amount: '-15.99',
      finalCategory: 'Entertainment',
    });
  }

  // Big-ticket charge without a receipt → triggers missing_receipt action.
  await makeTxn({
    date: '2026-05-04',
    merchantClean: 'BestBuy',
    merchantRaw: 'BEST BUY',
    amount: '-749.99',
    finalCategory: 'Electronics',
  });

  // Three reviewed-and-categorized rows for a single merchant → rule proposal.
  for (let i = 0; i < 3; i++) {
    await makeTxn({
      date: `2026-05-${String(20 + i).padStart(2, '0')}`,
      merchantClean: 'Coffee Shop',
      merchantRaw: 'COFFEE SHOP',
      amount: '-4.50',
      finalCategory: 'Coffee',
      reviewedAt: new Date(),
    });
  }

  // Planned event whose expectedDate is before the period end and still
  // planned → triggers forecast_warning. We pick a date a week before
  // periodEnd (2026-05-31) and well before "today".
  await models.PlannedEvent.create({
    householdId: primaryHouseholdId,
    userId: primaryUserId,
    accountId: primaryAccountId,
    type: 'expense',
    name: 'Rent',
    amount: '1500.0000',
    currency: 'CAD',
    expectedDate: '2026-05-15',
    status: 'planned',
    source: 'manual',
  } as never);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('POST /api/ai/review rejects missing periodStart', async () => {
  const r = await primaryAgent.post('/api/ai/review').send({});
  assert.equal(r.status, 400);
  assert.match(String(r.body.error), /periodStart/);
});

test('POST /api/ai/review rejects bad date format', async () => {
  const r = await primaryAgent.post('/api/ai/review').send({
    periodStart: '05/01/2026',
    periodEnd: '2026-05-31',
  });
  assert.equal(r.status, 400);
});

test('POST /api/ai/review rejects swapped period order', async () => {
  const r = await primaryAgent.post('/api/ai/review').send({
    periodStart: '2026-05-31',
    periodEnd: '2026-05-01',
  });
  assert.equal(r.status, 400);
});

test('POST /api/ai/review rejects bad currency', async () => {
  const r = await primaryAgent.post('/api/ai/review').send({
    periodStart: '2026-05-01',
    periodEnd: '2026-05-31',
    currency: 'CADX',
  });
  assert.equal(r.status, 400);
});

let primaryRunId = 0;

test('POST /api/ai/review creates a completed run with action items (no OpenAI)', async () => {
  const r = await primaryAgent.post('/api/ai/review').send({
    periodStart: '2026-05-01',
    periodEnd: '2026-05-31',
    currency: 'CAD',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'completed');
  assert.equal(r.body.householdId, primaryHouseholdId);
  assert.equal(r.body.userId, primaryUserId);
  assert.equal(r.body.periodStart, '2026-05-01');
  assert.equal(r.body.periodEnd, '2026-05-31');
  assert.equal(r.body.currency, 'CAD');
  assert.equal(r.body.model, 'deterministic');
  assert.equal(r.body.promptVersion, 'ai-review-v1');
  assert.equal(r.body.errorMessage, null);
  assert.ok(Array.isArray(r.body.actionItems));
  assert.ok(r.body.actionItems.length > 0, 'Expected at least one action item');
  primaryRunId = r.body.id as number;

  const types = new Set((r.body.actionItems as Array<{ type: string }>).map((i) => i.type));
  // Seed fixtures should produce all four classes.
  assert.ok(types.has('subscription'), `expected subscription in types: ${[...types].join(',')}`);
  assert.ok(types.has('missing_receipt'), `expected missing_receipt in types: ${[...types].join(',')}`);
  assert.ok(types.has('rule_suggestion'), `expected rule_suggestion in types: ${[...types].join(',')}`);
  assert.ok(types.has('forecast_warning'), `expected forecast_warning in types: ${[...types].join(',')}`);

  for (const item of r.body.actionItems as Array<{ id: string; status: string }>) {
    assert.ok(item.id, 'each action item must have a stable id');
    assert.equal(item.status, 'suggested');
  }
});

test('GET /api/ai/reviews lists runs newest-first, scoped to household', async () => {
  // Create a second run so the list returns multiple.
  const second = await primaryAgent.post('/api/ai/review').send({
    periodStart: '2026-04-01',
    periodEnd: '2026-04-30',
  });
  assert.equal(second.status, 201);

  const r = await primaryAgent.get('/api/ai/reviews');
  assert.equal(r.status, 200);
  const rows = r.body.data as Array<{ id: number; createdAt: string }>;
  assert.ok(rows.length >= 2);
  // Newest-first ordering.
  for (let i = 1; i < rows.length; i++) {
    assert.ok(
      rows[i - 1].createdAt >= rows[i].createdAt,
      `expected DESC by createdAt, got ${rows[i - 1].createdAt} then ${rows[i].createdAt}`,
    );
  }

  const otherCreated = await otherAgent.post('/api/ai/review').send({
    periodStart: '2026-05-01',
    periodEnd: '2026-05-31',
  });
  assert.equal(otherCreated.status, 201);
  const otherList = await otherAgent.get('/api/ai/reviews');
  assert.equal(otherList.status, 200);
  assert.equal((otherList.body.data as Array<{ id: number }>).length, 1);

  const primaryList = await primaryAgent.get('/api/ai/reviews');
  const primaryIds = (primaryList.body.data as Array<{ id: number }>).map((row) => row.id);
  assert.ok(!primaryIds.includes(otherCreated.body.id as number));
});

test('GET /api/ai/reviews/:id returns a single run with action items', async () => {
  const r = await primaryAgent.get(`/api/ai/reviews/${primaryRunId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.id, primaryRunId);
  assert.ok(Array.isArray(r.body.actionItems));
});

test('GET /api/ai/reviews/:id 404s for another household', async () => {
  const r = await otherAgent.get(`/api/ai/reviews/${primaryRunId}`);
  assert.equal(r.status, 404);
});

test('POST /api/ai/reviews/:id/items/:itemId/accept flips status to accepted', async () => {
  const detail = await primaryAgent.get(`/api/ai/reviews/${primaryRunId}`);
  assert.equal(detail.status, 200);
  const item = (detail.body.actionItems as Array<{ id: string; status: string }>)[0];
  assert.ok(item, 'precondition: at least one action item exists');

  const r = await primaryAgent.post(
    `/api/ai/reviews/${primaryRunId}/items/${encodeURIComponent(item.id)}/accept`,
  );
  assert.equal(r.status, 200);
  const updated = (r.body.actionItems as Array<{ id: string; status: string }>).find(
    (i) => i.id === item.id,
  );
  assert.ok(updated, 'updated item should still be present');
  assert.equal(updated!.status, 'accepted');
  // Other items unchanged.
  const others = (r.body.actionItems as Array<{ id: string; status: string }>).filter(
    (i) => i.id !== item.id,
  );
  for (const o of others) assert.equal(o.status, 'suggested');
});

test('POST /api/ai/reviews/:id/items/:itemId/dismiss flips status to dismissed', async () => {
  const detail = await primaryAgent.get(`/api/ai/reviews/${primaryRunId}`);
  const suggested = (detail.body.actionItems as Array<{ id: string; status: string }>).find(
    (i) => i.status === 'suggested',
  );
  assert.ok(suggested, 'precondition: a suggested item exists');
  const r = await primaryAgent.post(
    `/api/ai/reviews/${primaryRunId}/items/${encodeURIComponent(suggested!.id)}/dismiss`,
  );
  assert.equal(r.status, 200);
  const updated = (r.body.actionItems as Array<{ id: string; status: string }>).find(
    (i) => i.id === suggested!.id,
  );
  assert.equal(updated!.status, 'dismissed');
});

test('POST /api/ai/reviews/:id/items/:itemId/accept 404s for unknown item', async () => {
  const r = await primaryAgent.post(
    `/api/ai/reviews/${primaryRunId}/items/does-not-exist/accept`,
  );
  assert.equal(r.status, 404);
});

test('POST /api/ai/reviews/:id/items/:itemId/accept 404s for another household', async () => {
  const detail = await primaryAgent.get(`/api/ai/reviews/${primaryRunId}`);
  const itemId = (detail.body.actionItems as Array<{ id: string }>)[0]?.id;
  assert.ok(itemId);
  const r = await otherAgent.post(
    `/api/ai/reviews/${primaryRunId}/items/${encodeURIComponent(itemId)}/accept`,
  );
  assert.equal(r.status, 404);
});

test('GET /api/ai/reviews supports dateFrom/dateTo filters', async () => {
  const r = await primaryAgent
    .get('/api/ai/reviews')
    .query({ dateFrom: '2026-05-01', dateTo: '2026-05-31' });
  assert.equal(r.status, 200);
  const rows = r.body.data as Array<{ periodStart: string; periodEnd: string }>;
  for (const row of rows) {
    assert.ok(row.periodStart >= '2026-05-01');
    assert.ok(row.periodEnd <= '2026-05-31');
  }
});

// Anchor for unused vars to keep lint happy when adding tests later.
void otherHouseholdId;
void otherAccountId;
