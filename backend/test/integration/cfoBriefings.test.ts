/**
 * Integration tests for /api/cfo/briefings* (issue #236).
 *
 * Coverage:
 *  - POST /api/cfo/briefings creates a briefing with action items and snapshot
 *  - Default period (no body) → last 7 days through today
 *  - GET  /api/cfo/briefings lists briefings newest-first, household-scoped
 *  - GET  /api/cfo/briefings/:id returns a single briefing
 *  - GET  /api/cfo/briefings/:id 404s for another household
 *  - POST /api/cfo/briefings/:id/items/:itemId/resolve|dismiss flips status
 *  - Validation: bad dates, swapped order, bad currency, window too long
 *  - Briefing degrades gracefully without OpenAI (no key configured)
 *  - Action items include the new types: missing_receipt, rule_suggestion,
 *    forecast_warning, review_backlog, new_subscription, import_issue.
 *  - Briefing items include `link` paths for navigation (AC: links).
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
let primaryUserId: number;
let primaryAccountId: number;
let otherHouseholdId!: number;
let otherAccountId!: number;
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

function isoToday(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
}

before(async () => {
  // CRITICAL: NODE_ENV='test' before the route module loads so the
  // aiSuggestLimiter skip() short-circuits (the limiter would 429
  // multiple sequential POSTs from the same test client otherwise).
  process.env.NODE_ENV = 'test';
  delete process.env.OPENAI_API_KEY;

  testDb = await setupPgTestDb('cfo-briefings');
  const mod = await import('../../src/app.js');
  app = mod.default;

  // First registered user becomes superadmin — used only to bootstrap.
  const bootstrap = testAgent(app);
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
  primaryAgent = testAgent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('Other');
  otherHouseholdId = other.householdId;
  otherAccountId = other.accountId;
  otherAgent = testAgent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);

  // Fixtures: place them inside the default window (last 7 days through today).
  const today = isoToday();
  const fiveDaysAgo = isoDaysAgo(5);
  const sixDaysAgo = isoDaysAgo(6);

  const models = await import('../../src/models');

  type TxnSeed = {
    date: string;
    merchantRaw: string;
    merchantClean: string;
    amount: string;
    finalCategory?: string | null;
    reviewedAt?: Date | null;
    reviewFlag?: boolean;
  };
  async function makeTxn(seed: TxnSeed): Promise<void> {
    await models.Transaction.create({
      householdId: primaryHouseholdId,
      accountId: primaryAccountId,
      visibility: 'shared',
      importBatch: 'cfo-briefing-test',
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
      reviewFlag: seed.reviewFlag ?? false,
      reviewedAt: seed.reviewedAt ?? null,
    } as never);
  }

  // Big-ticket charge without a receipt → missing_receipt item.
  await makeTxn({
    date: fiveDaysAgo,
    merchantClean: 'BestBuy',
    merchantRaw: 'BEST BUY',
    amount: '-749.99',
    finalCategory: 'Electronics',
  });

  // Reviewed-and-categorized rows for a single merchant → rule_suggestion.
  for (let i = 0; i < 3; i++) {
    await makeTxn({
      date: isoDaysAgo(2 + i),
      merchantClean: 'Coffee Shop',
      merchantRaw: 'COFFEE SHOP',
      amount: '-4.50',
      finalCategory: 'Coffee',
      reviewedAt: new Date(),
    });
  }

  // Some flagged review-backlog transactions.
  for (let i = 0; i < 3; i++) {
    await makeTxn({
      date: isoDaysAgo(1),
      merchantClean: `ReviewMe${i}`,
      merchantRaw: `RV${i}`,
      amount: '-25.00',
      reviewFlag: true,
    });
  }

  // Planned event overdue → forecast_warning.
  await models.PlannedEvent.create({
    householdId: primaryHouseholdId,
    userId: primaryUserId,
    accountId: primaryAccountId,
    type: 'expense',
    name: 'Rent',
    amount: '1500.0000',
    currency: 'CAD',
    expectedDate: sixDaysAgo,
    status: 'planned',
    source: 'manual',
  } as never);

  // New subscription created in the window → new_subscription. Subscriptions
  // are folded into planned_events as kind='subscription' (Expectation merge);
  // legacy status 'active' maps to status='planned' + statusUncertain=false,
  // which is exactly what the briefing builder's new-subscription query filters
  // on. createdAt defaults to now() — inside the default 7-day window.
  await models.PlannedEvent.create({
    kind: 'subscription',
    type: 'expense',
    source: 'recurring_detection',
    userId: primaryUserId,
    householdId: primaryHouseholdId,
    name: 'Netflix',
    normalizedName: 'netflix',
    amount: '15.9900',
    currency: 'CAD',
    cadence: 'monthly',
    lastChargeDate: fiveDaysAgo,
    nextExpectedDate: today,
    expectedDate: today,
    status: 'planned',
    statusUncertain: false,
    annualizedCost: '191.8800',
    category: 'Entertainment',
  } as never);

  // Failed import → import_issue.
  await models.ImportHistory.create({
    fileName: 'failed.csv',
    householdId: primaryHouseholdId,
    createdByUserId: primaryUserId,
    filePathSafe: 'safe/path',
    contentHash: 'abc',
    batchLabel: 'failed-batch',
    status: 'failed',
    rowCount: 0,
    errorMessage: 'parse error on line 3',
    startedAt: new Date(),
    finishedAt: new Date(),
  } as never);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('POST /api/cfo/briefings rejects bad date format', async () => {
  const r = await primaryAgent.post('/api/cfo/briefings').send({
    periodStart: '05/01/2026',
    periodEnd: '2026-05-31',
  });
  assert.equal(r.status, 400);
});

test('POST /api/cfo/briefings rejects swapped period order', async () => {
  const r = await primaryAgent.post('/api/cfo/briefings').send({
    periodStart: '2026-05-31',
    periodEnd: '2026-05-01',
  });
  assert.equal(r.status, 400);
});

test('POST /api/cfo/briefings rejects bad currency', async () => {
  const r = await primaryAgent.post('/api/cfo/briefings').send({
    periodStart: isoDaysAgo(6),
    periodEnd: isoToday(),
    currency: 'CADX',
  });
  assert.equal(r.status, 400);
});

test('POST /api/cfo/briefings rejects windows above the max (14 days)', async () => {
  const r = await primaryAgent.post('/api/cfo/briefings').send({
    periodStart: isoDaysAgo(60),
    periodEnd: isoToday(),
  });
  assert.equal(r.status, 400);
  assert.match(String(r.body.error), /14 days/);
});

let primaryRunId = 0;

test('POST /api/cfo/briefings with no body defaults to last 7 days and returns 201', async () => {
  const r = await primaryAgent.post('/api/cfo/briefings').send({});
  assert.equal(r.status, 201, `Expected 201; got ${r.status} body=${JSON.stringify(r.body)}`);
  assert.equal(r.body.status, 'completed');
  assert.equal(r.body.householdId, primaryHouseholdId);
  assert.equal(r.body.userId, primaryUserId);
  assert.equal(r.body.currency, 'CAD');
  assert.equal(r.body.model, 'deterministic');
  assert.equal(r.body.promptVersion, 'cfo-briefing-v1');
  assert.equal(r.body.errorMessage, null);
  assert.ok(Array.isArray(r.body.actionItems));
  assert.ok(r.body.actionItems.length > 0, 'expected at least one action item');
  primaryRunId = r.body.id as number;

  const types = new Set(
    (r.body.actionItems as Array<{ type: string }>).map((i) => i.type),
  );
  assert.ok(types.has('missing_receipt'), `expected missing_receipt; got ${[...types].join(',')}`);
  assert.ok(types.has('rule_suggestion'), `expected rule_suggestion; got ${[...types].join(',')}`);
  assert.ok(types.has('forecast_warning'), `expected forecast_warning; got ${[...types].join(',')}`);
  assert.ok(types.has('review_backlog'), `expected review_backlog; got ${[...types].join(',')}`);
  assert.ok(types.has('new_subscription'), `expected new_subscription; got ${[...types].join(',')}`);
  assert.ok(types.has('import_issue'), `expected import_issue; got ${[...types].join(',')}`);

  // Every item gets a stable id and starts in 'open' status.
  for (const item of r.body.actionItems as Array<{ id: string; status: string; link?: string }>) {
    assert.ok(item.id, 'each action item must have a stable id');
    assert.equal(item.status, 'open');
    // AC: actionable items include a link
    assert.ok(item.link, 'each item must include a `link` for navigation');
  }
});

test('POST /api/cfo/briefings creates a briefing with explicit dates', async () => {
  const r = await primaryAgent.post('/api/cfo/briefings').send({
    periodStart: isoDaysAgo(6),
    periodEnd: isoToday(),
    currency: 'CAD',
  });
  assert.equal(r.status, 201);
});

test('GET /api/cfo/briefings lists briefings newest-first, household-scoped', async () => {
  const r = await primaryAgent.get('/api/cfo/briefings');
  assert.equal(r.status, 200);
  const rows = r.body.data as Array<{ id: number; createdAt: string }>;
  assert.ok(rows.length >= 2);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(
      rows[i - 1].createdAt >= rows[i].createdAt,
      `expected DESC by createdAt, got ${rows[i - 1].createdAt} then ${rows[i].createdAt}`,
    );
  }

  const otherCreated = await otherAgent.post('/api/cfo/briefings').send({});
  assert.equal(otherCreated.status, 201);
  const otherList = await otherAgent.get('/api/cfo/briefings');
  assert.equal(otherList.status, 200);
  assert.equal((otherList.body.data as Array<{ id: number }>).length, 1);

  const primaryList = await primaryAgent.get('/api/cfo/briefings');
  const primaryIds = (primaryList.body.data as Array<{ id: number }>).map((row) => row.id);
  assert.ok(!primaryIds.includes(otherCreated.body.id as number));
});

test('GET /api/cfo/briefings/:id returns a single briefing with action items', async () => {
  const r = await primaryAgent.get(`/api/cfo/briefings/${primaryRunId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.id, primaryRunId);
  assert.ok(Array.isArray(r.body.actionItems));
});

test('GET /api/cfo/briefings/:id 404s for another household', async () => {
  const r = await otherAgent.get(`/api/cfo/briefings/${primaryRunId}`);
  assert.equal(r.status, 404);
});

test('POST /api/cfo/briefings/:id/items/:itemId/resolve flips status to resolved', async () => {
  const detail = await primaryAgent.get(`/api/cfo/briefings/${primaryRunId}`);
  assert.equal(detail.status, 200);
  const item = (detail.body.actionItems as Array<{ id: string; status: string }>)[0];
  assert.ok(item);

  const r = await primaryAgent.post(
    `/api/cfo/briefings/${primaryRunId}/items/${encodeURIComponent(item.id)}/resolve`,
  );
  assert.equal(r.status, 200);
  const updated = (r.body.actionItems as Array<{ id: string; status: string }>).find(
    (i) => i.id === item.id,
  );
  assert.ok(updated);
  assert.equal(updated!.status, 'resolved');
  const others = (r.body.actionItems as Array<{ id: string; status: string }>).filter(
    (i) => i.id !== item.id,
  );
  for (const o of others) assert.equal(o.status, 'open');
});

test('POST /api/cfo/briefings/:id/items/:itemId/dismiss flips status to dismissed', async () => {
  const detail = await primaryAgent.get(`/api/cfo/briefings/${primaryRunId}`);
  const open = (detail.body.actionItems as Array<{ id: string; status: string }>).find(
    (i) => i.status === 'open',
  );
  assert.ok(open, 'precondition: an open item exists');
  const r = await primaryAgent.post(
    `/api/cfo/briefings/${primaryRunId}/items/${encodeURIComponent(open!.id)}/dismiss`,
  );
  assert.equal(r.status, 200);
  const updated = (r.body.actionItems as Array<{ id: string; status: string }>).find(
    (i) => i.id === open!.id,
  );
  assert.equal(updated!.status, 'dismissed');
});

test('POST /api/cfo/briefings/:id/items/:itemId/resolve 404s for unknown item', async () => {
  const r = await primaryAgent.post(
    `/api/cfo/briefings/${primaryRunId}/items/does-not-exist/resolve`,
  );
  assert.equal(r.status, 404);
});

test('POST /api/cfo/briefings/:id/items/:itemId/resolve 404s for another household', async () => {
  const detail = await primaryAgent.get(`/api/cfo/briefings/${primaryRunId}`);
  const itemId = (detail.body.actionItems as Array<{ id: string }>)[0]?.id;
  assert.ok(itemId);
  const r = await otherAgent.post(
    `/api/cfo/briefings/${primaryRunId}/items/${encodeURIComponent(itemId)}/resolve`,
  );
  assert.equal(r.status, 404);
});

test('GET /api/cfo/briefings supports dateFrom/dateTo filters', async () => {
  const r = await primaryAgent
    .get('/api/cfo/briefings')
    .query({ dateFrom: isoDaysAgo(14), dateTo: isoToday() });
  assert.equal(r.status, 200);
  const rows = r.body.data as Array<{ periodStart: string; periodEnd: string }>;
  for (const row of rows) {
    assert.ok(row.periodStart >= isoDaysAgo(14));
    assert.ok(row.periodEnd <= isoToday());
  }
});

// Anchor unused vars for lint.
void otherHouseholdId;
void otherAccountId;
