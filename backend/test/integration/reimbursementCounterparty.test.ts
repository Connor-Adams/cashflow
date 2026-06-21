/**
 * Integration tests for issue #374 — reimbursement tracker uses the
 * counterparty Contact for "expected from":
 *
 *  - POST /api/transactions/:id/reimbursable/promote-counterparty
 *    (one-click "Promote and use": create a Contact from `counterparty_raw`,
 *    link the transaction, and create the reimbursement in a single round-trip)
 *  - GET  /api/contacts/:id (returns the contact plus an `openReimbursements`
 *    aggregate `{ count, byCurrency, items }` so the contact detail view in
 *    `/settings/contacts` can render "Open reimbursements: $X across Y items"
 *    and the per-item list)
 *  - Bonus: a sanity check that the existing
 *    `POST /api/transactions/:id/reimbursable` endpoint (#216) still works for
 *    the manual-pick flow when a `contactId` is supplied — AC#4 ("existing
 *    manual flow unchanged").
 *
 * Seeding shape mirrors backend/test/integration/reimbursements.test.ts (the
 * #216 baseline) so the fixture conventions stay consistent. The aiSuggestLimiter
 * gotcha applies — set NODE_ENV='test' BEFORE importing the app.
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
  options: {
    createdByUserId?: number | null;
    currency?: string;
    counterpartyRaw?: string | null;
    counterpartyContactId?: number | null;
  } = {},
): Promise<number> {
  const models = await import('../../src/models');
  const created = await models.Transaction.create({
    accountId,
    householdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'reimb-cp-test',
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
    counterpartyRaw: options.counterpartyRaw ?? null,
    counterpartyContactId: options.counterpartyContactId ?? null,
  });
  return created.id;
}

before(async () => {
  // CRITICAL: NODE_ENV='test' before route modules load so the
  // aiSuggestLimiter skip() short-circuits. Pattern mirrors
  // backend/test/integration/reimbursements.test.ts (#216).
  process.env.NODE_ENV = 'test';

  testDb = await setupPgTestDb('reimb-cp');
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
  primaryAgent = testAgent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('Other');
  otherHouseholdId = other.householdId;
  otherAccountId = other.accountId;
  otherAgent = testAgent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// Squelch unused-var false positive for primaryUserId (kept for future tests).
void primaryUserId;

// ----------------------------------------------------------------------------
// AC #1 — manual contactId pre-fill still works (sanity)
// ----------------------------------------------------------------------------

test('AC#1: client-supplied contactId from counterparty pre-fill is honored', async () => {
  // The frontend reads txn.counterpartyContactId and passes it as contactId in
  // the body. Server doesn't need a code change — verify the existing route
  // accepts it and links the contact correctly when the txn was created with
  // counterpartyContactId already populated.
  const models = await import('../../src/models');
  const contact = await models.Contact.create({
    householdId: primaryHouseholdId,
    name: 'Pre-fill Friend',
    notes: null,
  });
  const txnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-02-10',
    -42,
    { counterpartyRaw: 'PRE FILL FRIEND', counterpartyContactId: contact.id },
  );
  const res = await primaryAgent
    .post(`/api/transactions/${txnId}/reimbursable`)
    .send({ contactId: contact.id });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.contactId, contact.id);
  assert.equal(res.body.data.partyLabel, 'Pre-fill Friend');
});

// ----------------------------------------------------------------------------
// AC #2 — promote-and-use endpoint
// ----------------------------------------------------------------------------

test('AC#2: promote-counterparty creates Contact, links txn, and creates claim', async () => {
  const txnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-02-11',
    -88,
    { counterpartyRaw: 'JANE SMITH', counterpartyContactId: null },
  );
  const res = await primaryAgent
    .post(`/api/transactions/${txnId}/reimbursable/promote-counterparty`)
    .send({ dueDate: '2026-03-11' });
  assert.equal(res.status, 201);
  // Reimbursement created
  assert.ok(res.body.reimbursement, 'reimbursement payload expected');
  assert.equal(res.body.reimbursement.transactionId, txnId);
  assert.equal(res.body.reimbursement.amount, '88.0000');
  assert.equal(res.body.reimbursement.currency, 'CAD');
  assert.equal(res.body.reimbursement.dueDate, '2026-03-11');
  // Contact created and linked
  assert.ok(res.body.contact, 'contact payload expected');
  assert.equal(res.body.contact.name, 'JANE SMITH');
  assert.equal(res.body.reimbursement.contactId, res.body.contact.id);
  // Transaction was actually updated (DB roundtrip — not just echoed).
  const models = await import('../../src/models');
  const txn = await models.Transaction.findByPk(txnId);
  assert.ok(txn, 'transaction should exist');
  assert.equal(txn!.counterpartyContactId, res.body.contact.id);
});

test('AC#2: promote-counterparty reuses an existing Contact with the same raw name', async () => {
  const models = await import('../../src/models');
  // Pre-create a contact with a name that exactly matches the raw value.
  const existing = await models.Contact.create({
    householdId: primaryHouseholdId,
    name: 'BOB STUFFINGTON',
    notes: null,
  });
  const txnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-02-12',
    -19.50,
    { counterpartyRaw: 'BOB STUFFINGTON', counterpartyContactId: null },
  );
  const res = await primaryAgent
    .post(`/api/transactions/${txnId}/reimbursable/promote-counterparty`)
    .send({});
  assert.equal(res.status, 201);
  assert.equal(res.body.contact.id, existing.id, 'should reuse existing contact');
  assert.equal(res.body.reimbursement.contactId, existing.id);
});

test('AC#2: promote-counterparty rejects when counterparty_raw is missing', async () => {
  const txnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-02-13',
    -10,
    { counterpartyRaw: null, counterpartyContactId: null },
  );
  const res = await primaryAgent
    .post(`/api/transactions/${txnId}/reimbursable/promote-counterparty`)
    .send({});
  assert.equal(res.status, 400);
});

test('AC#2: promote-counterparty rejects when transaction is already linked to a Contact', async () => {
  const models = await import('../../src/models');
  const existing = await models.Contact.create({
    householdId: primaryHouseholdId,
    name: 'Already Linked',
    notes: null,
  });
  const txnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-02-14',
    -5,
    { counterpartyRaw: 'ALREADY LINKED', counterpartyContactId: existing.id },
  );
  const res = await primaryAgent
    .post(`/api/transactions/${txnId}/reimbursable/promote-counterparty`)
    .send({});
  // Should reject so the user is steered to pass contactId via the regular
  // /reimbursable endpoint instead (which the frontend pre-fill flow does).
  assert.equal(res.status, 400);
});

test('AC#2: promote-counterparty 404 across households', async () => {
  const otherTxn = await createTransaction(
    otherHouseholdId,
    otherAccountId,
    '2026-02-15',
    -25,
    { counterpartyRaw: 'OTHER PARTY', counterpartyContactId: null },
  );
  const res = await primaryAgent
    .post(`/api/transactions/${otherTxn}/reimbursable/promote-counterparty`)
    .send({});
  assert.equal(res.status, 404);
});

// ----------------------------------------------------------------------------
// AC #3 — Contact detail returns open-reimbursements aggregate
// ----------------------------------------------------------------------------

test('AC#3: GET /contacts/:id returns openReimbursements aggregate + items', async () => {
  // Fresh seed so we can count exactly.
  const fresh = await seed('AggContact');
  const agent = testAgent(app);
  agent.jar.setCookie(`cashflow_session=${fresh.token}; Path=/`);

  // Two outstanding claims (one CAD, one USD) and one received claim — only
  // the outstanding ones should land in openReimbursements.
  const t1 = await createTransaction(fresh.householdId, fresh.accountId, '2026-05-01', -60);
  await agent
    .post(`/api/transactions/${t1}/reimbursable`)
    .send({ contactId: fresh.contactId, amount: 60 });

  const t2 = await createTransaction(fresh.householdId, fresh.accountId, '2026-05-02', -40, {
    currency: 'USD',
  });
  await agent
    .post(`/api/transactions/${t2}/reimbursable`)
    .send({ contactId: fresh.contactId, amount: 40, currency: 'USD' });

  const t3 = await createTransaction(fresh.householdId, fresh.accountId, '2026-05-03', -15);
  const created3 = await agent
    .post(`/api/transactions/${t3}/reimbursable`)
    .send({ contactId: fresh.contactId, amount: 15 });
  // Mark this one received — it should NOT appear in openReimbursements.
  await agent
    .put(`/api/reimbursements/${created3.body.data.id}`)
    .send({ status: 'received' });

  const res = await agent.get(`/api/contacts/${fresh.contactId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, fresh.contactId);
  assert.equal(res.body.name, 'AggContact Contact');
  assert.ok(res.body.openReimbursements, 'openReimbursements aggregate expected');
  assert.equal(res.body.openReimbursements.count, 2, 'should count only OPEN claims');
  assert.equal(res.body.openReimbursements.byCurrency.CAD, '60.0000');
  assert.equal(res.body.openReimbursements.byCurrency.USD, '40.0000');
  assert.ok(Array.isArray(res.body.openReimbursements.items));
  assert.equal(res.body.openReimbursements.items.length, 2);
  // Items are open (expected or derived-overdue); none should be received.
  for (const item of res.body.openReimbursements.items) {
    assert.ok(
      item.effectiveStatus === 'expected' || item.effectiveStatus === 'overdue',
      `item ${item.id} should be open, got ${item.effectiveStatus}`,
    );
  }
});

test('AC#3: GET /contacts/:id 404 across households', async () => {
  const fresh = await seed('AggAcrossHH');
  const agent = testAgent(app);
  agent.jar.setCookie(`cashflow_session=${fresh.token}; Path=/`);
  // primaryAgent should not be able to read this contact.
  const res = await primaryAgent.get(`/api/contacts/${fresh.contactId}`);
  assert.equal(res.status, 404);
});

test('AC#3: GET /contacts/:id returns empty aggregate when no claims', async () => {
  const fresh = await seed('AggEmpty');
  const agent = testAgent(app);
  agent.jar.setCookie(`cashflow_session=${fresh.token}; Path=/`);
  const res = await agent.get(`/api/contacts/${fresh.contactId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.openReimbursements.count, 0);
  assert.deepEqual(res.body.openReimbursements.byCurrency, {});
  assert.deepEqual(res.body.openReimbursements.items, []);
});
