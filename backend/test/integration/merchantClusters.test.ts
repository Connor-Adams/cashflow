/**
 * Integration tests for the merchant-cleanup review surface (issue #793),
 * added to `backend/src/routes/merchants.ts` + `backend/src/merchants/clusters.ts`:
 *
 *   - GET  /api/merchants/clusters
 *   - POST /api/merchants/bulk-recategorize
 *   - POST /api/merchants/merge
 *
 * Setup mirrors `merchants.test.ts`: one Postgres test DB, a bootstrap
 * superadmin, plus two non-superadmin households (A and B) seeded via
 * `seedHousehold`, each with its own session-cookie agent so we can assert
 * household isolation. Each household gets a Category row so bulk-recategorize
 * has a valid category to assign.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { seedHousehold } from '../helpers/seedHousehold.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let agentA: ReturnType<typeof request.agent>;
let agentB: ReturnType<typeof request.agent>;
let householdAId: number;
let householdBId: number;
let userAId: number;
let accountAId: number;
let accountBId: number;
let testDb: PgTestDb;

type TxnSeed = {
  householdId: number;
  accountId: number;
  date: string;
  amount: number;
  currency?: string;
  merchantRaw?: string;
  merchantClean?: string;
  merchantCanonical?: string | null;
  finalCategory?: string | null;
  createdByUserId?: number | null;
};

async function createTxn(seed: TxnSeed): Promise<number> {
  const models = await import('../../src/models');
  const row = await models.Transaction.create({
    accountId: seed.accountId,
    householdId: seed.householdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'merchant-clusters-test',
    date: seed.date,
    merchantRaw: seed.merchantRaw ?? 'Test Merchant',
    merchantClean: seed.merchantClean ?? seed.merchantRaw ?? 'Test Merchant',
    merchantCanonical: seed.merchantCanonical ?? null,
    amount: seed.amount.toFixed(4),
    currency: seed.currency ?? 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: seed.finalCategory ?? null,
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
    myShareAmount: '0',
    partnerShareAmount: '0',
    businessAmount: '0',
    txnType: 'purchase',
    autoSource: null,
    autoConfidence: null,
    linkedTransactionId: null,
    isRecurring: false,
    reviewFlag: false,
    reviewedAt: null,
    createdByUserId: seed.createdByUserId ?? null,
  });
  return row.id;
}

before(async () => {
  process.env.NODE_ENV = 'test';
  testDb = await setupPgTestDb('merchant_clusters');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const superAgent = testAgent(app);
  const register = await superAgent.post('/api/auth/register').send({
    email: 'super-clusters@example.com',
    displayName: 'Super Clusters',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const a = await seedHousehold('ClustersA', 'A Partner');
  householdAId = a.householdId;
  userAId = a.userId;
  agentA = testAgent(app);
  agentA.jar.setCookie(`cashflow_session=${a.token}; Path=/`);

  const b = await seedHousehold('ClustersB', 'B Partner');
  householdBId = b.householdId;
  agentB = testAgent(app);
  agentB.jar.setCookie(`cashflow_session=${b.token}; Path=/`);

  const models = await import('../../src/models');
  const acctA = await models.Account.create({
    householdId: householdAId,
    ownerUserId: userAId,
    owner: 'me',
    visibility: 'shared',
    name: 'A Chequing',
    accountType: 'checking',
    defaultCurrency: 'CAD',
    shortCode: 'C-A-CHQ',
  });
  accountAId = acctA.id;
  const acctB = await models.Account.create({
    householdId: householdBId,
    ownerUserId: b.userId,
    owner: 'me',
    visibility: 'shared',
    name: 'B Chequing',
    accountType: 'checking',
    defaultCurrency: 'CAD',
    shortCode: 'C-B-CHQ',
  });
  accountBId = acctB.id;

  // Valid categories for bulk-recategorize.
  await models.Category.create({ householdId: householdAId, parentId: null, name: 'Coffee' });
  await models.Category.create({ householdId: householdAId, parentId: null, name: 'Dining' });
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// ── seed + request helpers (keep each test terse, avoid clone groups) ──────

/** Seed a household-A transaction; only the varying fields are passed. */
function seedA(
  date: string,
  amount: number,
  fields: Partial<TxnSeed> = {},
): Promise<number> {
  return createTxn({ householdId: householdAId, accountId: accountAId, date, amount, ...fields });
}

/** GET /clusters for an agent and return the parsed cluster array. */
async function getClusters(
  agent: ReturnType<typeof request.agent>,
  currency = 'CAD',
): Promise<Array<Record<string, unknown>>> {
  const res = await agent.get('/api/merchants/clusters').query({ currency });
  assert.equal(res.status, 200);
  return res.body.clusters as Array<Record<string, unknown>>;
}

/** The merchant_clean keys of an agent's clusters, in returned order. */
async function clusterCleans(
  agent: ReturnType<typeof request.agent>,
): Promise<string[]> {
  return (await getClusters(agent)).map((c) => c.merchantClean as string);
}

/** Read back the merchant_canonical values of every row in a cluster. */
async function canonicalsOf(clean: string): Promise<Array<string | null>> {
  const models = await import('../../src/models');
  const rows = await models.Transaction.findAll({
    where: { householdId: householdAId, merchantClean: clean },
    attributes: ['merchantCanonical'],
    raw: true,
  });
  return (rows as Array<{ merchantCanonical: string | null }>).map((r) => r.merchantCanonical);
}

// ───────────────────────── unauthenticated ─────────────────────────

test('clusters/bulk-recategorize/merge reject unauthenticated requests with 401', async () => {
  const anon = testAgent(app);
  const r1 = await anon.get('/api/merchants/clusters');
  assert.equal(r1.status, 401);
  const r2 = await anon.post('/api/merchants/bulk-recategorize').send({ merchantClean: 'X', category: 'Coffee' });
  assert.equal(r2.status, 401);
  const r3 = await anon.post('/api/merchants/merge').send({ survivorMerchantClean: 'X' });
  assert.equal(r3.status, 401);
});

// ───────────────────────── GET /clusters ─────────────────────────

test('/clusters: one entry per distinct merchant_clean, sorted by spend desc', async () => {
  // Blue Bottle cluster: 3 spend rows (80 total), mixed categories, + a refund.
  await seedA('2026-01-01', -50, { merchantRaw: 'SQ *BLUE BOTTLE', merchantClean: 'BLUE BOTTLE COFFEE', finalCategory: 'Coffee' });
  await seedA('2026-01-02', -20, { merchantRaw: 'BLUE BOTTLE COFFEE #12', merchantClean: 'BLUE BOTTLE COFFEE', finalCategory: 'Coffee' });
  await seedA('2026-01-03', -10, { merchantRaw: 'BLUE BOTTLE', merchantClean: 'BLUE BOTTLE COFFEE', finalCategory: 'Dining' });
  await seedA('2026-01-04', -5, { merchantRaw: 'TINY CAFE', merchantClean: 'TINY CAFE', finalCategory: 'Coffee' });
  await seedA('2026-01-05', 7, { merchantRaw: 'BLUE BOTTLE REFUND', merchantClean: 'BLUE BOTTLE COFFEE', finalCategory: 'Coffee' }); // refund excluded from spend

  const clusters = await getClusters(agentA);
  const cleans = clusters.map((c) => c.merchantClean as string);
  const blue = clusters.find((c) => c.merchantClean === 'BLUE BOTTLE COFFEE');
  const tiny = clusters.find((c) => c.merchantClean === 'TINY CAFE');
  assert.ok(blue, 'BLUE BOTTLE COFFEE cluster present');
  assert.ok(tiny, 'TINY CAFE cluster present');

  assert.equal(blue.count, 4, '4 rows including the refund row');
  assert.equal(blue.totalSpend, '80.00', 'spend = 50+20+10, refund excluded');
  assert.equal(blue.currency, 'CAD');
  assert.equal(blue.dominantCategory, 'Coffee', '3 Coffee vs 1 Dining');
  assert.ok((blue.categorySpread as unknown[]).length >= 2, 'mixed-category spread');
  assert.ok((blue.sampleDescriptions as unknown[]).length >= 1, 'has a sample description');
  assert.ok(
    cleans.indexOf('BLUE BOTTLE COFFEE') < cleans.indexOf('TINY CAFE'),
    `expected Blue Bottle before Tiny Cafe: ${JSON.stringify(cleans)}`,
  );
});

test('/clusters never leaks another household; B sees only its own', async () => {
  await createTxn({ householdId: householdBId, accountId: accountBId, date: '2026-02-01', amount: -12, merchantRaw: 'B ONLY', merchantClean: 'B ONLY SHOP', finalCategory: null });

  assert.deepEqual(await clusterCleans(agentB), ['B ONLY SHOP']);

  const cleansA = await clusterCleans(agentA);
  assert.ok(!cleansA.includes('B ONLY SHOP'), `cross-household leak: ${JSON.stringify(cleansA)}`);
});

test('/clusters rejects an unknown currency with 400', async () => {
  const res = await agentA.get('/api/merchants/clusters').query({ currency: 'ZZZ' });
  assert.equal(res.status, 400);
});

// ───────────────────── POST /bulk-recategorize ─────────────────────

test('bulk-recategorize sets final_category on every cluster row and returns exact count', async () => {
  const res = await agentA
    .post('/api/merchants/bulk-recategorize')
    .send({ merchantClean: 'BLUE BOTTLE COFFEE', category: 'Coffee' });
  assert.equal(res.status, 200);
  assert.equal(res.body.recategorized, 4, 'all 4 Blue Bottle CAD rows recategorized');
  assert.equal(res.body.ruleCreated, false);
  assert.equal(res.body.ruleId, null);

  const models = await import('../../src/models');
  const rows = await models.Transaction.findAll({
    where: { householdId: householdAId, merchantClean: 'BLUE BOTTLE COFFEE' },
    attributes: ['finalCategory'],
    raw: true,
  });
  for (const r of rows as Array<{ finalCategory: string | null }>) {
    assert.equal(r.finalCategory, 'Coffee');
  }
});

test('bulk-recategorize rejects unknown category (400) and missing cluster (404)', async () => {
  const bad = await agentA
    .post('/api/merchants/bulk-recategorize')
    .send({ merchantClean: 'BLUE BOTTLE COFFEE', category: 'NotARealCategory' });
  assert.equal(bad.status, 400);

  const missing = await agentA
    .post('/api/merchants/bulk-recategorize')
    .send({ merchantClean: 'DOES NOT EXIST CLUSTER', category: 'Coffee' });
  assert.equal(missing.status, 404);

  const empty = await agentA
    .post('/api/merchants/bulk-recategorize')
    .send({ merchantClean: '', category: 'Coffee' });
  assert.equal(empty.status, 400);
});

test('bulk-recategorize with createRule creates one rule and is idempotent (409 on repeat)', async () => {
  const first = await agentA
    .post('/api/merchants/bulk-recategorize')
    .send({ merchantClean: 'TINY CAFE', category: 'Coffee', createRule: true });
  assert.equal(first.status, 200);
  assert.equal(first.body.ruleCreated, true);
  assert.ok(typeof first.body.ruleId === 'number');

  const models = await import('../../src/models');
  const rules = await models.Rule.findAll({
    where: { householdId: householdAId, merchantPattern: 'TINY CAFE' },
    raw: true,
  });
  assert.equal(rules.length, 1, 'exactly one rule created for the cluster');

  const second = await agentA
    .post('/api/merchants/bulk-recategorize')
    .send({ merchantClean: 'TINY CAFE', category: 'Coffee', createRule: true });
  assert.equal(second.status, 409, 'duplicate create-rule returns 409');

  const rulesAfter = await models.Rule.findAll({
    where: { householdId: householdAId, merchantPattern: 'TINY CAFE' },
    raw: true,
  });
  assert.equal(rulesAfter.length, 1, 'no duplicate rule created');
});

// ───────────────────────── POST /merge ─────────────────────────

test('merge reassigns canonical of merge clusters to the survivor and returns count', async () => {
  // Seed three sibling clusters of the same real merchant.
  await seedA('2026-03-01', -11, { merchantClean: 'STARBUCKS', finalCategory: 'Coffee' });
  await seedA('2026-03-02', -12, { merchantClean: 'SBUX', finalCategory: 'Coffee' });
  await seedA('2026-03-03', -13, { merchantClean: 'STARBUCKS COFFEE', finalCategory: 'Coffee' });

  const res = await agentA.post('/api/merchants/merge').send({
    survivorMerchantClean: 'STARBUCKS',
    mergeMerchantCleans: ['SBUX', 'STARBUCKS COFFEE'],
    canonicalName: 'Starbucks',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.survivor, 'Starbucks');
  assert.equal(res.body.reassigned, 3, 'all three rows now carry the survivor canonical');

  for (const clean of ['STARBUCKS', 'SBUX', 'STARBUCKS COFFEE']) {
    for (const canonical of await canonicalsOf(clean)) {
      assert.equal(canonical, 'Starbucks');
    }
  }
});

test('merge rename-only (empty merge list) updates only the survivor cluster', async () => {
  await seedA('2026-04-01', -9, { merchantClean: 'LONE WOLF', finalCategory: 'Dining' });
  await seedA('2026-04-02', -8, { merchantClean: 'BYSTANDER', finalCategory: 'Dining' }); // must NOT be touched

  const res = await agentA.post('/api/merchants/merge').send({
    survivorMerchantClean: 'LONE WOLF',
    mergeMerchantCleans: [],
    canonicalName: 'Lone Wolf Diner',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.survivor, 'Lone Wolf Diner');

  assert.deepEqual(await canonicalsOf('LONE WOLF'), ['Lone Wolf Diner']);
  assert.deepEqual(await canonicalsOf('BYSTANDER'), [null], 'bystander untouched');
});

test('merge rejects survivor appearing in merge list (400) and missing survivor (404)', async () => {
  const selfMerge = await agentA.post('/api/merchants/merge').send({
    survivorMerchantClean: 'STARBUCKS',
    mergeMerchantCleans: ['STARBUCKS'],
  });
  assert.equal(selfMerge.status, 400);

  const noSurvivor = await agentA.post('/api/merchants/merge').send({
    survivorMerchantClean: '',
  });
  assert.equal(noSurvivor.status, 400);

  const missing = await agentA.post('/api/merchants/merge').send({
    survivorMerchantClean: 'NOPE NOT HERE',
    mergeMerchantCleans: [],
    canonicalName: 'Nope',
  });
  assert.equal(missing.status, 404);
});
