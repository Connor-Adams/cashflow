/**
 * Integration tests for the purchase intelligence route surface
 * (issue #218). Exercises POST/GET/DELETE /api/transactions/:id/purchase,
 * GET /api/purchases (with filter variants), and GET /api/purchases/large-inbox
 * end-to-end against a real Postgres database. Mirrors the seeding shape
 * used by businessTax.test.ts.
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
  return { token, householdId: household.id, userId: user.id, accountId: account.id };
}

async function createTransaction(
  householdId: number,
  accountId: number,
  userId: number,
  date: string,
  category: string | null,
  amount: number,
  options: { business?: boolean; merchant?: string; currency?: string } = {},
): Promise<number> {
  const models = await import('../../src/models');
  const created = await models.Transaction.create({
    accountId,
    householdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'purchase-intel-test',
    date,
    merchantRaw: options.merchant ?? 'Test Merchant',
    merchantClean: options.merchant ?? 'Test Merchant',
    amount: amount.toFixed(4),
    currency: options.currency ?? 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: category,
    autoBusiness: null,
    businessOverride: options.business ?? null,
    finalBusiness: options.business ?? false,
    autoSplitType: null,
    splitOverride: null,
    finalSplitType: 'me',
    autoPctMe: null,
    pctMeOverride: null,
    finalPctMe: null,
    autoPctPartner: null,
    pctPartnerOverride: null,
    finalPctPartner: null,
    reviewFlag: false,
    reviewedAt: null,
    createdByUserId: userId,
  });
  return created.id;
}

before(async () => {
  testDb = await setupPgTestDb('purchases');
  const mod = await import('../../src/app.js');
  app = mod.default;

  // Bootstrap a superadmin (first registered user) so we can use the regular
  // endpoints later with non-superadmin agents.
  const bootstrap = request.agent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const primary = await seed('Primary');
  primaryHouseholdId = primary.householdId;
  primaryAccountId = primary.accountId;
  primaryAgent = request.agent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('Other');
  otherHouseholdId = other.householdId;
  otherAccountId = other.accountId;
  otherAgent = request.agent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// ---- POST /api/transactions/:id/purchase --------------------------------

test('POST /api/transactions/:id/purchase creates a profile for a transaction', async () => {
  const txnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    1, // bootstrap superadmin user id
    '2025-05-01',
    'Electronics',
    -1200,
    { merchant: 'Apple Store' },
  );

  // Make a request using the primary agent — but the transaction is in the
  // primary household; we need to seed it via the primary user explicitly.
  const models = await import('../../src/models');
  await models.Transaction.update(
    { createdByUserId: null },
    { where: { id: txnId } },
  );

  const res = await primaryAgent
    .post(`/api/transactions/${txnId}/purchase`)
    .send({
      receiptStatus: 'saved',
      warrantyStatus: 'active',
      warrantyExpiresAt: '2027-05-01',
      warrantyProvider: 'AppleCare',
      businessRelevant: false,
      usefulLifeMonths: 60,
      notes: 'New MacBook Pro for personal use',
    });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.receiptStatus, 'saved');
  assert.equal(res.body.data.warrantyStatus, 'active');
  assert.equal(res.body.data.warrantyExpiresAt, '2027-05-01');
  assert.equal(res.body.data.warrantyProvider, 'AppleCare');
  assert.equal(res.body.data.usefulLifeMonths, 60);
  assert.equal(res.body.data.businessRelevant, false);
  assert.equal(res.body.data.transaction.id, txnId);
  assert.equal(res.body.data.transaction.merchant, 'Apple Store');
  // 1200 / 60 = 20.00 cost per month over declared life.
  assert.equal(res.body.data.costPerMonth, 20);
});

test('POST /api/transactions/:id/purchase upserts when called twice', async () => {
  const txnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    1,
    '2025-06-01',
    'Furniture',
    -800,
  );
  const first = await primaryAgent
    .post(`/api/transactions/${txnId}/purchase`)
    .send({ receiptStatus: 'missing' });
  assert.equal(first.status, 201);
  assert.equal(first.body.data.receiptStatus, 'missing');

  const second = await primaryAgent
    .post(`/api/transactions/${txnId}/purchase`)
    .send({ receiptStatus: 'saved', notes: 'Found the receipt in email' });
  assert.equal(second.status, 200);
  assert.equal(second.body.data.receiptStatus, 'saved');
  assert.equal(second.body.data.notes, 'Found the receipt in email');
});

test('POST /api/transactions/:id/purchase rejects invalid receiptStatus', async () => {
  const txnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    1,
    '2025-07-01',
    'Tools',
    -200,
  );
  const res = await primaryAgent
    .post(`/api/transactions/${txnId}/purchase`)
    .send({ receiptStatus: 'definitely-not-a-status' });
  assert.equal(res.status, 400);
});

test('POST /api/transactions/:id/purchase rejects usefulLifeMonths out of range', async () => {
  const txnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    1,
    '2025-07-02',
    'Tools',
    -200,
  );
  const res = await primaryAgent
    .post(`/api/transactions/${txnId}/purchase`)
    .send({ usefulLifeMonths: 1000 });
  assert.equal(res.status, 400);
});

test('POST /api/transactions/:id/purchase 404 when transaction is in another household', async () => {
  const otherTxnId = await createTransaction(
    otherHouseholdId,
    otherAccountId,
    1,
    '2025-08-01',
    'Furniture',
    -500,
  );
  const res = await primaryAgent
    .post(`/api/transactions/${otherTxnId}/purchase`)
    .send({ receiptStatus: 'saved' });
  assert.equal(res.status, 404);
});

// ---- GET /api/transactions/:id/purchase ---------------------------------

test('GET /api/transactions/:id/purchase returns the profile', async () => {
  const txnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    1,
    '2025-04-15',
    'Electronics',
    -300,
  );
  await primaryAgent
    .post(`/api/transactions/${txnId}/purchase`)
    .send({ receiptStatus: 'saved' });

  const res = await primaryAgent.get(`/api/transactions/${txnId}/purchase`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.transactionId, txnId);
  assert.equal(res.body.data.receiptStatus, 'saved');
});

test('GET /api/transactions/:id/purchase 404 when not tracked', async () => {
  const txnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    1,
    '2025-04-16',
    'Electronics',
    -150,
  );
  const res = await primaryAgent.get(`/api/transactions/${txnId}/purchase`);
  assert.equal(res.status, 404);
});

// ---- DELETE /api/transactions/:id/purchase ------------------------------

test('DELETE /api/transactions/:id/purchase removes the profile', async () => {
  const txnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    1,
    '2025-04-17',
    'Tools',
    -120,
  );
  await primaryAgent
    .post(`/api/transactions/${txnId}/purchase`)
    .send({ receiptStatus: 'saved' });

  const del = await primaryAgent.delete(`/api/transactions/${txnId}/purchase`);
  assert.equal(del.status, 204);

  const get = await primaryAgent.get(`/api/transactions/${txnId}/purchase`);
  assert.equal(get.status, 404);
});

test('DELETE /api/transactions/:id/purchase 404 when not tracked', async () => {
  const txnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    1,
    '2025-04-18',
    'Tools',
    -75,
  );
  const res = await primaryAgent.delete(`/api/transactions/${txnId}/purchase`);
  assert.equal(res.status, 404);
});

// ---- GET /api/purchases (filters) ---------------------------------------

test('GET /api/purchases returns only the requesting household profiles', async () => {
  // Seed a purchase in the OTHER household via a fresh transaction.
  const otherTxnId = await createTransaction(
    otherHouseholdId,
    otherAccountId,
    1,
    '2025-03-01',
    'Electronics',
    -1500,
  );
  await otherAgent
    .post(`/api/transactions/${otherTxnId}/purchase`)
    .send({ receiptStatus: 'saved' });

  const primaryList = await primaryAgent.get('/api/purchases');
  const otherList = await otherAgent.get('/api/purchases');
  assert.equal(primaryList.status, 200);
  assert.equal(otherList.status, 200);

  // Primary household must not see the OTHER's transaction.
  const primaryIds = (primaryList.body.data as Array<{ transactionId: number }>).map(
    (r) => r.transactionId,
  );
  const otherIds = (otherList.body.data as Array<{ transactionId: number }>).map(
    (r) => r.transactionId,
  );
  assert.ok(!primaryIds.includes(otherTxnId), 'primary must not see other household txn');
  assert.ok(otherIds.includes(otherTxnId), 'other must see its own txn');
});

test('GET /api/purchases?filter=large filters by minAmount', async () => {
  const smallTxnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    1,
    '2025-02-01',
    'Misc',
    -50,
  );
  const bigTxnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    1,
    '2025-02-02',
    'Electronics',
    -3500,
  );
  await primaryAgent
    .post(`/api/transactions/${smallTxnId}/purchase`)
    .send({ receiptStatus: 'saved' });
  await primaryAgent
    .post(`/api/transactions/${bigTxnId}/purchase`)
    .send({ receiptStatus: 'saved' });

  const res = await primaryAgent.get('/api/purchases?filter=large&minAmount=500');
  assert.equal(res.status, 200);
  const ids = (res.body.data as Array<{ transactionId: number }>).map((r) => r.transactionId);
  assert.ok(ids.includes(bigTxnId), 'big purchase must be in the large-filter result');
  assert.ok(!ids.includes(smallTxnId), 'small purchase must be excluded');
});

test('GET /api/purchases?filter=business filters to business-relevant profiles', async () => {
  const bizTxnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    1,
    '2025-01-01',
    'Office',
    -1200,
    { business: true },
  );
  await primaryAgent
    .post(`/api/transactions/${bizTxnId}/purchase`)
    .send({ businessRelevant: true });

  const res = await primaryAgent.get('/api/purchases?filter=business');
  assert.equal(res.status, 200);
  const ids = (res.body.data as Array<{ transactionId: number }>).map((r) => r.transactionId);
  assert.ok(ids.includes(bizTxnId));
});

test('GET /api/purchases?filter=missing-docs flags purchases without a receipt or with unknown status', async () => {
  const missingTxnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    1,
    '2024-12-01',
    'Electronics',
    -700,
  );
  // Note: do NOT attach a Receipt row, and use status 'missing'.
  await primaryAgent
    .post(`/api/transactions/${missingTxnId}/purchase`)
    .send({ receiptStatus: 'missing' });

  const res = await primaryAgent.get('/api/purchases?filter=missing-docs');
  assert.equal(res.status, 200);
  const ids = (res.body.data as Array<{ transactionId: number }>).map((r) => r.transactionId);
  assert.ok(ids.includes(missingTxnId));
});

// ---- GET /api/purchases/large-inbox -------------------------------------

test('GET /api/purchases/large-inbox lists large UNMARKED transactions', async () => {
  const candidateTxnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    1,
    '2025-09-01',
    'Furniture',
    -1800,
  );
  // Add a tracked smaller purchase that must NOT appear.
  const otherTxnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    1,
    '2025-09-02',
    'Misc',
    -25,
  );
  await primaryAgent
    .post(`/api/transactions/${otherTxnId}/purchase`)
    .send({ receiptStatus: 'saved' });

  const res = await primaryAgent.get('/api/purchases/large-inbox?minAmount=500');
  assert.equal(res.status, 200);
  const ids = (res.body.data as Array<{ id: number }>).map((r) => r.id);
  assert.ok(ids.includes(candidateTxnId), 'large unmarked txn must surface');
});

test('GET /api/purchases/large-inbox excludes already-tracked purchases', async () => {
  const bigTxnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    1,
    '2025-10-01',
    'Electronics',
    -2500,
  );
  await primaryAgent
    .post(`/api/transactions/${bigTxnId}/purchase`)
    .send({ receiptStatus: 'saved' });

  const res = await primaryAgent.get('/api/purchases/large-inbox?minAmount=500');
  assert.equal(res.status, 200);
  const ids = (res.body.data as Array<{ id: number }>).map((r) => r.id);
  assert.ok(!ids.includes(bigTxnId), 'tracked purchase must be excluded from large-inbox');
});

// ---- Pre-existing transactions remain queryable -------------------------

test('Existing transactions continue to work without a purchase profile', async () => {
  // List a transaction (no purchase metadata). It must still appear in
  // /api/transactions via the normal endpoint — we don't go through it here
  // because the transactions route is large; instead, prove the model layer
  // doesn't choke and the purchase association is null.
  const models = await import('../../src/models');
  const txnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    1,
    '2025-11-01',
    'Groceries',
    -45,
  );
  const txn = await models.Transaction.findByPk(txnId, {
    include: [{ model: models.Purchase, as: 'purchase' }],
  });
  assert.ok(txn, 'transaction must be findable by id');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((txn as any).purchase, null);
});
