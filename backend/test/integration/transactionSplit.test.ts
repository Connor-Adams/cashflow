/**
 * Integration tests for the multiway transaction split endpoints (Task 3):
 *   POST   /api/transactions/:id/split
 *   DELETE /api/transactions/:id/split
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let primaryAgent: ReturnType<typeof request.agent>;
let primaryHouseholdId: number;
let primaryAccountId: number;
let primaryUserId: number;
let primaryContactId: number;
let otherContactId: number;
let testDb: PgTestDb;

type Seeded = {
  token: string;
  householdId: number;
  userId: number;
  accountId: number;
  contactId: number;
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
  const contact = await models.Contact.create({
    householdId: household.id,
    name: `${emailPrefix} Contact`,
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

async function createTransaction(
  householdId: number,
  accountId: number,
  date: string,
  amount: number,
  options: { createdByUserId?: number | null; currency?: string } = {},
): Promise<number> {
  const models = await import('../../src/models');
  const created = await models.Transaction.create({
    accountId,
    householdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'split-test',
    date,
    merchantRaw: 'Test Merchant',
    merchantClean: 'Test Merchant',
    amount: amount.toFixed(4),
    currency: options.currency ?? 'CAD',
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
    reviewFlag: false,
    reviewedAt: null,
    createdByUserId: options.createdByUserId ?? null,
  });
  return created.id;
}

async function createContact(
  householdId: number,
  name: string,
  opts: { isSelf?: boolean } = {},
): Promise<number> {
  const models = await import('../../src/models');
  const c = await models.Contact.create({ householdId, name, notes: null, isSelf: opts.isSelf ?? false });
  return c.id;
}

before(async () => {
  process.env.NODE_ENV = 'test';

  testDb = await setupPgTestDb('transactionSplit');
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
  primaryUserId = primary.userId;
  primaryContactId = primary.contactId;
  primaryAgent = testAgent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('Other');
  otherContactId = other.contactId;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// ---- split endpoint tests --------------------------------------------------

test('POST /split even 3-way creates 2 claims + sets txn to me', async () => {
  const txnId = await createTransaction(primaryHouseholdId, primaryAccountId, '2026-04-01', -302.71, {
    createdByUserId: primaryUserId,
  });
  const dad = primaryContactId;
  const alex = await createContact(primaryHouseholdId, 'Alex');
  const res = await primaryAgent
    .post(`/api/transactions/${txnId}/split`)
    .send({ method: 'even', participants: [{ contactId: dad }, { contactId: alex }], includeSelf: true })
    .expect(201);
  assert.equal(res.body.claims.length, 2);
  assert.equal(res.body.transaction.finalSplitType, 'me');
  const amounts = res.body.claims.map((c: { amount: string }) => c.amount).sort();
  assert.deepEqual(amounts, ['100.9000', '100.9000']);
  assert.ok(res.body.claims.every((c: { fromSplit: boolean }) => c.fromSplit === true));
});

test('re-split replaces prior from_split claims, keeps manual ones', async () => {
  const txnId = await createTransaction(primaryHouseholdId, primaryAccountId, '2026-04-02', -90, {
    createdByUserId: primaryUserId,
  });
  // a manual claim (from_split defaults false)
  await primaryAgent
    .post(`/api/transactions/${txnId}/reimbursable`)
    .send({ contactId: primaryContactId, amount: '10.00' })
    .expect(201);
  await primaryAgent
    .post(`/api/transactions/${txnId}/split`)
    .send({ method: 'even', participants: [{ contactId: primaryContactId }], includeSelf: true })
    .expect(201);
  // re-split with a different shape
  const res = await primaryAgent
    .post(`/api/transactions/${txnId}/split`)
    .send({ method: 'percent', participants: [{ contactId: primaryContactId, pct: 50 }], includeSelf: true })
    .expect(201);
  assert.equal(res.body.claims.length, 1);
  // list all claims for the txn: 1 manual + 1 split = 2
  const list = await primaryAgent.get(`/api/reimbursements?transactionId=${txnId}`).expect(200);
  assert.equal(list.body.data.length, 2);
});

test('DELETE /split removes only split claims', async () => {
  const txnId = await createTransaction(primaryHouseholdId, primaryAccountId, '2026-04-03', -60, {
    createdByUserId: primaryUserId,
  });
  await primaryAgent
    .post(`/api/transactions/${txnId}/reimbursable`)
    .send({ contactId: primaryContactId, amount: '5.00' })
    .expect(201);
  await primaryAgent
    .post(`/api/transactions/${txnId}/split`)
    .send({ method: 'even', participants: [{ contactId: primaryContactId }], includeSelf: true })
    .expect(201);
  await primaryAgent.delete(`/api/transactions/${txnId}/split`).expect(200);
  const list = await primaryAgent.get(`/api/reimbursements?transactionId=${txnId}`).expect(200);
  assert.equal(list.body.data.length, 1); // only the manual one survives
});

test('rejects self-contact participant', async () => {
  const txnId = await createTransaction(primaryHouseholdId, primaryAccountId, '2026-04-04', -40, {
    createdByUserId: primaryUserId,
  });
  const selfContact = await createContact(primaryHouseholdId, 'Me', { isSelf: true });
  await primaryAgent
    .post(`/api/transactions/${txnId}/split`)
    .send({ method: 'even', participants: [{ contactId: selfContact }], includeSelf: true })
    .expect(400);
});

test('rejects contact from another household', async () => {
  const txnId = await createTransaction(primaryHouseholdId, primaryAccountId, '2026-04-05', -40, {
    createdByUserId: primaryUserId,
  });
  await primaryAgent
    .post(`/api/transactions/${txnId}/split`)
    .send({ method: 'even', participants: [{ contactId: otherContactId }], includeSelf: true })
    .expect(400);
});
