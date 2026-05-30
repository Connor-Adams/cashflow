/**
 * Integration tests for /api/search (issue #235). Run via
 * `yarn test:integration`. Asserts:
 *  - empty query → 200 with helpful message
 *  - invalid syntax → 200 with errors[] populated
 *  - filter combinations (merchant, category, amount, date, scope, receipt)
 *  - cross-household isolation
 *  - saved-search CRUD with unique-name enforcement
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
    name: `${emailPrefix} Account`,
    owner: 'me',
    defaultCurrency: 'CAD',
  } as never);
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

interface TxnSeedOpts {
  householdId: number;
  accountId: number;
  createdByUserId: number;
  date: string;
  amount: string;
  merchant: string;
  category?: string | null;
  business?: boolean;
  splitType?: string;
  recurring?: boolean;
  reviewFlag?: boolean;
  notes?: string | null;
}

async function seedTxn(opts: TxnSeedOpts) {
  const { Transaction } = await import('../../src/models');
  return Transaction.create({
    householdId: opts.householdId,
    accountId: opts.accountId,
    createdByUserId: opts.createdByUserId,
    visibility: 'shared',
    currency: 'CAD',
    date: opts.date,
    merchantRaw: opts.merchant.toUpperCase(),
    merchantClean: opts.merchant,
    importBatch: 'search-test',
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    amount: opts.amount,
    finalCategory: opts.category ?? null,
    finalBusiness: opts.business ?? false,
    finalSplitType: opts.splitType ?? 'me',
    isRecurring: opts.recurring ?? false,
    reviewFlag: opts.reviewFlag ?? false,
    notes: opts.notes ?? null,
  } as never);
}

before(async () => {
  // Must come before the app import so aiSuggestLimiter (which checks
  // NODE_ENV at request time) no-ops during this suite. See kindex node
  // 3e2d48ca1f5f.
  process.env.NODE_ENV = 'test';

  testDb = await setupPgTestDb('search');
  const mod = await import('../../src/app.js');
  app = mod.default;

  // Bootstrap a superadmin (first registered user becomes superadmin).
  const bootstrap = request.agent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin-search@example.com',
    displayName: 'Super Admin Search',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const primary = await seed('PrimarySearch');
  primaryHouseholdId = primary.householdId;
  primaryUserId = primary.userId;
  primaryAccountId = primary.accountId;
  primaryAgent = request.agent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('OtherSearch');
  otherHouseholdId = other.householdId;
  otherUserId = other.userId;
  otherAccountId = other.accountId;
  otherAgent = request.agent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/search with empty query returns helpful guidance', async () => {
  const r = await primaryAgent.get('/api/search').query({ q: '' });
  assert.equal(r.status, 200);
  assert.equal(r.body.intent.isEmpty, true);
  assert.equal(r.body.total, 0);
  assert.match(r.body.message ?? '', /category|amount|date|scope/);
});

test('GET /api/search with invalid syntax returns 200 + errors[]', async () => {
  const r = await primaryAgent.get('/api/search').query({ q: 'amount:abc' });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.intent.errors));
  assert.equal(r.body.intent.errors.length, 1);
  assert.match(r.body.intent.errors[0], /Invalid amount/);
});

test('GET /api/search with category:Groceries filters by exact category', async () => {
  await seedTxn({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    createdByUserId: primaryUserId,
    date: '2026-04-01',
    amount: '-25.00',
    merchant: 'Loblaws',
    category: 'Groceries',
  });
  await seedTxn({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    createdByUserId: primaryUserId,
    date: '2026-04-02',
    amount: '-12.00',
    merchant: 'Starbucks',
    category: 'Dining',
  });

  const r = await primaryAgent.get('/api/search').query({ q: 'category:Groceries' });
  assert.equal(r.status, 200);
  const merchants = (r.body.results as Array<{ merchantClean: string }>).map((x) => x.merchantClean);
  assert.ok(merchants.includes('Loblaws'));
  assert.ok(!merchants.includes('Starbucks'));
  assert.equal(r.body.total, merchants.filter((m) => m === 'Loblaws').length);
});

test('GET /api/search amount:>100 matches by absolute magnitude (signed amounts)', async () => {
  await seedTxn({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    createdByUserId: primaryUserId,
    date: '2026-04-10',
    amount: '-150.00', // big spend
    merchant: 'BigPurchase',
    category: 'Electronics',
  });
  await seedTxn({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    createdByUserId: primaryUserId,
    date: '2026-04-11',
    amount: '50.00', // small refund
    merchant: 'TinyRefund',
    category: 'Electronics',
  });

  const r = await primaryAgent
    .get('/api/search')
    .query({ q: 'amount:>100 category:Electronics' });
  assert.equal(r.status, 200);
  const merchants = (r.body.results as Array<{ merchantClean: string }>).map((x) => x.merchantClean);
  assert.ok(merchants.includes('BigPurchase'));
  assert.ok(!merchants.includes('TinyRefund'));
});

test('GET /api/search date range filters by inclusive ISO range', async () => {
  await seedTxn({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    createdByUserId: primaryUserId,
    date: '2026-06-15',
    amount: '-10.00',
    merchant: 'JuneTxn',
  });
  await seedTxn({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    createdByUserId: primaryUserId,
    date: '2026-07-15',
    amount: '-10.00',
    merchant: 'JulyTxn',
  });

  const r = await primaryAgent
    .get('/api/search')
    .query({ q: 'date:2026-06-01..2026-06-30 merchant:Txn' });
  assert.equal(r.status, 200);
  const merchants = (r.body.results as Array<{ merchantClean: string }>).map((x) => x.merchantClean);
  assert.ok(merchants.includes('JuneTxn'));
  assert.ok(!merchants.includes('JulyTxn'));
});

test('GET /api/search scope:business returns only business-classified txns', async () => {
  await seedTxn({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    createdByUserId: primaryUserId,
    date: '2026-08-01',
    amount: '-75.00',
    merchant: 'BizExpense',
    category: 'Office',
    business: true,
  });
  await seedTxn({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    createdByUserId: primaryUserId,
    date: '2026-08-02',
    amount: '-15.00',
    merchant: 'PersonalCoffee',
    category: 'Dining',
    business: false,
  });

  const r = await primaryAgent.get('/api/search').query({ q: 'scope:business' });
  assert.equal(r.status, 200);
  const merchants = (r.body.results as Array<{ merchantClean: string }>).map((x) => x.merchantClean);
  assert.ok(merchants.includes('BizExpense'));
  assert.ok(!merchants.includes('PersonalCoffee'));
});

test('GET /api/search scope:recurring returns only recurring txns', async () => {
  await seedTxn({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    createdByUserId: primaryUserId,
    date: '2026-09-01',
    amount: '-15.99',
    merchant: 'NetflixOne',
    recurring: true,
  });
  await seedTxn({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    createdByUserId: primaryUserId,
    date: '2026-09-02',
    amount: '-5.00',
    merchant: 'NetflixTwo',
    recurring: false,
  });

  const r = await primaryAgent.get('/api/search').query({ q: 'scope:recurring merchant:Netflix' });
  assert.equal(r.status, 200);
  const merchants = (r.body.results as Array<{ merchantClean: string }>).map((x) => x.merchantClean);
  assert.ok(merchants.includes('NetflixOne'));
  assert.ok(!merchants.includes('NetflixTwo'));
});

test('GET /api/search has:receipt returns only txns with a receipt', async () => {
  const txnWith = await seedTxn({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    createdByUserId: primaryUserId,
    date: '2026-10-01',
    amount: '-200.00',
    merchant: 'ReceiptedMerchant',
    category: 'Travel',
  });
  await seedTxn({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    createdByUserId: primaryUserId,
    date: '2026-10-02',
    amount: '-50.00',
    merchant: 'NoReceiptMerchant',
    category: 'Travel',
  });
  const { Receipt } = await import('../../src/models');
  await Receipt.create({
    transactionId: txnWith.id,
    storedFilename: `receipt-test-${Date.now()}.pdf`,
    originalName: 'receipt.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
  } as never);

  const r = await primaryAgent
    .get('/api/search')
    .query({ q: 'has:receipt category:Travel' });
  assert.equal(r.status, 200);
  const merchants = (r.body.results as Array<{ merchantClean: string }>).map((x) => x.merchantClean);
  assert.ok(merchants.includes('ReceiptedMerchant'));
  assert.ok(!merchants.includes('NoReceiptMerchant'));
});

test('GET /api/search scopes by household — does not return other-household txns', async () => {
  await seedTxn({
    householdId: otherHouseholdId,
    accountId: otherAccountId,
    createdByUserId: otherUserId,
    date: '2026-11-01',
    amount: '-99999.00',
    merchant: 'OtherHouseholdSecret',
    category: 'Mystery',
  });

  const r = await primaryAgent
    .get('/api/search')
    .query({ q: 'merchant:OtherHouseholdSecret' });
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 0);
});

test('GET /api/search/saved returns empty list initially', async () => {
  const r = await primaryAgent.get('/api/search/saved');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, []);
});

test('POST /api/search/saved creates a saved search', async () => {
  const r = await primaryAgent
    .post('/api/search/saved')
    .send({ name: 'big-grocery-runs', query: 'category:Groceries amount:>100' });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, 'big-grocery-runs');
  assert.equal(r.body.query, 'category:Groceries amount:>100');
});

test('POST /api/search/saved rejects empty name', async () => {
  const r = await primaryAgent
    .post('/api/search/saved')
    .send({ name: '', query: 'foo:bar' });
  assert.equal(r.status, 400);
});

test('POST /api/search/saved rejects duplicate name with 409', async () => {
  const r = await primaryAgent
    .post('/api/search/saved')
    .send({ name: 'big-grocery-runs', query: 'category:Other' });
  assert.equal(r.status, 409);
});

test('PATCH /api/search/saved/:id updates name and query', async () => {
  const list = await primaryAgent.get('/api/search/saved');
  const row = list.body.find((r: { name: string }) => r.name === 'big-grocery-runs');
  assert.ok(row);
  const r = await primaryAgent
    .patch(`/api/search/saved/${row.id}`)
    .send({ name: 'big-grocery-runs-v2', query: 'category:Groceries amount:>200' });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'big-grocery-runs-v2');
  assert.equal(r.body.query, 'category:Groceries amount:>200');
});

test('DELETE /api/search/saved/:id removes the row', async () => {
  const list = await primaryAgent.get('/api/search/saved');
  const row = list.body.find((r: { name: string }) => r.name === 'big-grocery-runs-v2');
  assert.ok(row);
  const r = await primaryAgent.delete(`/api/search/saved/${row.id}`);
  assert.equal(r.status, 204);
  const after = await primaryAgent.get('/api/search/saved');
  assert.equal(after.body.length, 0);
});

test('PATCH /api/search/saved/:id 404s for another user', async () => {
  const created = await primaryAgent
    .post('/api/search/saved')
    .send({ name: 'primary-only', query: 'category:Foo' });
  assert.equal(created.status, 201);
  const r = await otherAgent
    .patch(`/api/search/saved/${created.body.id}`)
    .send({ name: 'hacked' });
  assert.equal(r.status, 404);
});

test('GET /api/search/saved returns only the calling user\'s rows', async () => {
  // primary has 'primary-only', other has nothing yet.
  await otherAgent
    .post('/api/search/saved')
    .send({ name: 'other-only', query: 'category:Bar' });
  const primary = await primaryAgent.get('/api/search/saved');
  const other = await otherAgent.get('/api/search/saved');
  const primaryNames = primary.body.map((r: { name: string }) => r.name);
  const otherNames = other.body.map((r: { name: string }) => r.name);
  assert.ok(primaryNames.includes('primary-only'));
  assert.ok(!primaryNames.includes('other-only'));
  assert.ok(otherNames.includes('other-only'));
  assert.ok(!otherNames.includes('primary-only'));
});
