/**
 * Integration tests for GET /api/contacts/:id/reimbursements (issue #374),
 * the Contact-detail "Reimbursements" section: aggregate open amount + count
 * (per currency) plus the per-item list. Exercised end-to-end against a real
 * Postgres database.
 *
 * Seeding shape mirrors reimbursements.test.ts (accounts use the seeded user's
 * id — never a literal id — to satisfy the owner_user_id FK). The reimbursement
 * router carries aiSuggestLimiter, so NODE_ENV='test' is set first in before().
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
let primaryContactId: number;
let otherAgent: ReturnType<typeof request.agent>;
let otherHouseholdId: number;
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
  currency = 'CAD',
): Promise<number> {
  const models = await import('../../src/models');
  const created = await models.Transaction.create({
    accountId,
    householdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'contact-reimb-test',
    date,
    merchantRaw: 'Test Merchant',
    merchantClean: 'Test Merchant',
    amount: amount.toFixed(4),
    currency,
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
    createdByUserId: null,
  });
  return created.id;
}

function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Create a reimbursement claim for `contactId` via the public route. */
async function createClaim(
  agent: ReturnType<typeof request.agent>,
  contactId: number,
  householdId: number,
  accountId: number,
  amount: number,
  opts: { currency?: string; dueDate?: string | null } = {},
): Promise<number> {
  const txnId = await createTransaction(
    householdId,
    accountId,
    '2026-02-01',
    -amount,
    opts.currency ?? 'CAD',
  );
  const body: Record<string, unknown> = { contactId, amount };
  if (opts.currency) body.currency = opts.currency;
  if (opts.dueDate !== undefined) body.dueDate = opts.dueDate;
  const res = await agent.post(`/api/transactions/${txnId}/reimbursable`).send(body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data.id as number;
}

before(async () => {
  // CRITICAL: NODE_ENV='test' before the app/route modules load so the
  // aiSuggestLimiter skip() short-circuits (the reimbursements router mounts
  // it on every route). Mirrors reimbursements/cfoBriefings/statements tests.
  process.env.NODE_ENV = 'test';

  testDb = await setupPgTestDb('contact_reimbursements');
  const mod = await import('../../src/app.js');
  app = mod.default;

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
  primaryContactId = primary.contactId;
  primaryAgent = request.agent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('Other');
  otherHouseholdId = other.householdId;
  otherContactId = other.contactId;
  otherAgent = request.agent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('returns empty items + zero aggregate for a contact with no claims', async () => {
  const res = await primaryAgent.get(`/api/contacts/${primaryContactId}/reimbursements`);
  assert.equal(res.status, 200);
  assert.equal(res.body.contact.id, primaryContactId);
  assert.deepEqual(res.body.items, []);
  assert.equal(res.body.aggregate.open.count, 0);
  assert.equal(res.body.aggregate.open.overdueCount, 0);
  assert.deepEqual(res.body.aggregate.open.byCurrency, {});
  assert.equal(res.body.aggregate.total.count, 0);
});

test('aggregates open (expected + overdue) amount + count by currency', async () => {
  // Fresh contact so counts are isolated from other tests in this file.
  const models = await import('../../src/models');
  const contact = await models.Contact.create({
    householdId: primaryHouseholdId,
    name: `Aggregate Target ${Date.now()}`,
    notes: null,
  });

  // Two open CAD claims (one future-due, one already overdue), one open USD
  // claim, one that gets matched to a repayment (received → not open).
  await createClaim(primaryAgent, contact.id, primaryHouseholdId, primaryAccountId, 100, {
    dueDate: isoDaysFromNow(30),
  });
  await createClaim(primaryAgent, contact.id, primaryHouseholdId, primaryAccountId, 50, {
    dueDate: isoDaysFromNow(-5), // overdue
  });
  await createClaim(primaryAgent, contact.id, primaryHouseholdId, primaryAccountId, 25, {
    currency: 'USD',
    dueDate: isoDaysFromNow(30),
  });
  const receivedClaim = await createClaim(
    primaryAgent,
    contact.id,
    primaryHouseholdId,
    primaryAccountId,
    999,
    { dueDate: isoDaysFromNow(10) },
  );
  // Mark that one received via PUT so it leaves the open set.
  const put = await primaryAgent
    .put(`/api/reimbursements/${receivedClaim}`)
    .send({ status: 'received' });
  assert.equal(put.status, 200);

  const res = await primaryAgent.get(`/api/contacts/${contact.id}/reimbursements`);
  assert.equal(res.status, 200);
  assert.equal(res.body.contact.name, contact.name);
  // All four claims appear in the item list.
  assert.equal(res.body.items.length, 4);
  assert.equal(res.body.aggregate.total.count, 4);
  // Open = the three not-received claims.
  assert.equal(res.body.aggregate.open.count, 3);
  assert.equal(res.body.aggregate.open.overdueCount, 1);
  assert.equal(res.body.aggregate.open.byCurrency.CAD, '150.0000');
  assert.equal(res.body.aggregate.open.byCurrency.USD, '25.0000');
  // Every item is tied to the requested contact.
  for (const item of res.body.items) {
    assert.equal(item.contactId, contact.id);
  }
});

test('404 for a contact in another household', async () => {
  const res = await primaryAgent.get(`/api/contacts/${otherContactId}/reimbursements`);
  assert.equal(res.status, 404);
});

test('does not leak claims across households', async () => {
  // Give the OTHER household a claim on its own contact, then confirm the
  // primary household cannot see it (it 404s on the foreign contact id).
  await createClaim(otherAgent, otherContactId, otherHouseholdId, otherAccountId, 42);
  const leak = await primaryAgent.get(`/api/contacts/${otherContactId}/reimbursements`);
  assert.equal(leak.status, 404);

  // And the other household sees exactly its own claim.
  const own = await otherAgent.get(`/api/contacts/${otherContactId}/reimbursements`);
  assert.equal(own.status, 200);
  assert.equal(own.body.aggregate.open.count, 1);
  assert.equal(own.body.aggregate.open.byCurrency.CAD, '42.0000');
});

test('400 for a non-numeric contact id', async () => {
  const res = await primaryAgent.get('/api/contacts/not-a-number/reimbursements');
  assert.equal(res.status, 400);
});
