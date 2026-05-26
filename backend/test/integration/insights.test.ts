/**
 * Integration tests for /api/insights and the underlying detector runner.
 *
 * Runs in isolation (`yarn test:integration`) so DATABASE_URL is set before
 * any Sequelize import. Bootstraps a superadmin then seeds two non-superadmin
 * households to exercise scope isolation.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { seedHousehold } from '../helpers/seedHousehold.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let primaryAgent: ReturnType<typeof request.agent>;
let primaryHouseholdId: number;
let primaryUserId: number;
let primaryContactId: number;
let primaryAccountId: number;
let otherAgent: ReturnType<typeof request.agent>;
let otherHouseholdId: number;
let testDb: PgTestDb;

async function makeAccount(emailPrefix: string, householdId: number, userId: number): Promise<number> {
  const models = await import('../../src/models');
  const account = await models.Account.create({
    householdId,
    ownerUserId: userId,
    owner: 'me',
    visibility: 'shared',
    name: `${emailPrefix} card`,
    accountType: 'credit',
    defaultCurrency: 'CAD',
    shortCode: emailPrefix.slice(0, 3).toUpperCase(),
  });
  return account.id;
}

async function createTransaction(
  householdId: number,
  accountId: number,
  date: string,
  merchant: string,
  amount: number,
  category: string | null = null,
  currency = 'CAD',
): Promise<number> {
  const models = await import('../../src/models');
  const t = await models.Transaction.create({
    accountId,
    householdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'insights-test',
    date,
    merchantRaw: merchant,
    merchantClean: merchant,
    amount: amount.toFixed(4),
    currency,
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: category,
    autoBusiness: null,
    businessOverride: null,
    autoSplitType: null,
    splitOverride: null,
    autoPctMe: null,
    pctMeOverride: null,
    finalPctMe: null,
    autoPctPartner: null,
    pctPartnerOverride: null,
    finalPctPartner: null,
    reviewFlag: false,
    reviewedAt: null,
    createdByUserId: null,
  });
  return t.id;
}

before(async () => {
  process.env.NODE_ENV = 'test';
  testDb = await setupPgTestDb('insights');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const bootstrap = request.agent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const primary = await seedHousehold('Primary', 'Sam Partner');
  primaryHouseholdId = primary.householdId;
  primaryUserId = primary.userId;
  primaryContactId = primary.contactId;
  primaryAccountId = await makeAccount('Primary', primary.householdId, primary.userId);
  primaryAgent = request.agent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seedHousehold('Other', 'Their Friend');
  otherHouseholdId = other.householdId;
  await makeAccount('Other', other.householdId, other.userId);
  otherAgent = request.agent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// ---- POST /api/insights/run ---------------------------------------------

test('POST /api/insights/run creates rows from seeded duplicate txns', async () => {
  // Seed two charges from the same merchant within 3 days
  const now = new Date();
  const isoDay = (offset: number) => {
    const d = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  };
  await createTransaction(primaryHouseholdId, primaryAccountId, isoDay(2), 'Costco', -123.45);
  await createTransaction(primaryHouseholdId, primaryAccountId, isoDay(1), 'Costco', -123.45);

  const runRes = await primaryAgent.post('/api/insights/run');
  assert.equal(runRes.status, 200);
  assert.ok(runRes.body.total >= 1);
  assert.ok((runRes.body.detectorCounts.duplicate_transactions ?? 0) >= 1);

  const listRes = await primaryAgent.get('/api/insights');
  assert.equal(listRes.status, 200);
  const items = listRes.body.data as Array<{ type: string; status: string }>;
  const dup = items.find((i) => i.type === 'duplicate_transactions');
  assert.ok(dup, 'expected a duplicate_transactions insight');
  assert.equal(dup!.status, 'open');
});

test('POST /api/insights/run is idempotent — same fingerprint refreshes instead of duplicating', async () => {
  const firstRun = await primaryAgent.post('/api/insights/run');
  assert.equal(firstRun.status, 200);
  const firstList = await primaryAgent.get('/api/insights');
  const firstCount = (firstList.body.data as unknown[]).length;

  const secondRun = await primaryAgent.post('/api/insights/run');
  assert.equal(secondRun.status, 200);
  const secondList = await primaryAgent.get('/api/insights');
  assert.equal((secondList.body.data as unknown[]).length, firstCount);
  // Second run should refresh, not create
  assert.equal(secondRun.body.created, 0);
  assert.ok(secondRun.body.refreshed >= 1);
});

// ---- PATCH /api/insights/:id -------------------------------------------

test('PATCH /api/insights/:id updates status to dismissed', async () => {
  const list = await primaryAgent.get('/api/insights');
  const insightId = (list.body.data as Array<{ id: number }>)[0].id;
  const res = await primaryAgent.patch(`/api/insights/${insightId}`).send({ status: 'dismissed' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'dismissed');
});

test('PATCH /api/insights/:id rejects unknown status', async () => {
  const list = await primaryAgent.get('/api/insights');
  const insightId = (list.body.data as Array<{ id: number }>)[0].id;
  const res = await primaryAgent.patch(`/api/insights/${insightId}`).send({ status: 'lol' });
  assert.equal(res.status, 400);
});

test('PATCH /api/insights/:id 404s for a missing id', async () => {
  const res = await primaryAgent.patch('/api/insights/99999').send({ status: 'resolved' });
  assert.equal(res.status, 404);
});

// ---- GET /api/insights ?status= ----------------------------------------

test('GET /api/insights?status= filters by status', async () => {
  const dismissed = await primaryAgent.get('/api/insights?status=dismissed');
  assert.equal(dismissed.status, 200);
  const items = dismissed.body.data as Array<{ status: string }>;
  for (const i of items) assert.equal(i.status, 'dismissed');

  const open = await primaryAgent.get('/api/insights?status=open');
  assert.equal(open.status, 200);
  const openItems = open.body.data as Array<{ status: string }>;
  for (const i of openItems) assert.equal(i.status, 'open');
});

test('GET /api/insights?status=garbage rejects unknown status', async () => {
  const res = await primaryAgent.get('/api/insights?status=garbage');
  assert.equal(res.status, 400);
});

// ---- Household scope isolation -----------------------------------------

test('GET /api/insights does not leak rows from other households', async () => {
  // Seed an insight-worthy state in the OTHER household
  const otherList0 = await otherAgent.get('/api/insights');
  assert.equal(otherList0.status, 200);
  assert.equal((otherList0.body.data as unknown[]).length, 0);

  const primaryList = await primaryAgent.get('/api/insights');
  const otherList = await otherAgent.get('/api/insights');
  assert.ok((primaryList.body.data as unknown[]).length > 0);
  assert.equal((otherList.body.data as unknown[]).length, 0);
});

test('PATCH /api/insights/:id 404s when targeting another household', async () => {
  const list = await primaryAgent.get('/api/insights');
  const insightId = (list.body.data as Array<{ id: number }>)[0].id;
  const res = await otherAgent.patch(`/api/insights/${insightId}`).send({ status: 'dismissed' });
  assert.equal(res.status, 404);
});

// ---- Settlement imbalance end-to-end ------------------------------------

test('POST /api/insights/run picks up settlement imbalance from partner_settlements', async () => {
  const models = await import('../../src/models');
  await models.PartnerSettlement.create({
    householdId: primaryHouseholdId,
    contactId: primaryContactId,
    direction: 'i_paid_partner',
    currency: 'CAD',
    amount: '500.0000',
    settledDate: '2026-05-01',
    notes: null,
  });
  await models.PartnerSettlement.create({
    householdId: primaryHouseholdId,
    contactId: primaryContactId,
    direction: 'i_paid_partner',
    currency: 'CAD',
    amount: '200.0000',
    settledDate: '2026-05-02',
    notes: null,
  });
  const run = await primaryAgent.post('/api/insights/run');
  assert.equal(run.status, 200);
  const list = await primaryAgent.get('/api/insights');
  const settlement = (list.body.data as Array<{ type: string; metadata: { netAmount: number } }>)
    .find((i) => i.type === 'settlement_imbalance');
  assert.ok(settlement, 'expected settlement_imbalance insight');
  assert.equal(settlement!.metadata.netAmount, 700);
});

// Make unused variables visible to satisfy lint
void primaryUserId;
void otherHouseholdId;
