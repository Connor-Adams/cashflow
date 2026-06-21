/**
 * Integration tests for POST /api/transactions/:id/counterparty/promote (#372).
 *
 * Covers:
 *   - Auto-create mode (no contactId): creates a new Contact from
 *     counterpartyRaw, links the txn, returns serialized txn + contact.
 *   - Auto-create mode reuses an existing Contact when (householdId, name)
 *     already matches — no duplicate Contact row.
 *   - Explicit contactId mode: links to the supplied Contact when it
 *     belongs to the caller's household.
 *   - Auto-create rejects (400) when counterpartyRaw is null/empty.
 *   - Explicit contactId rejects (400) for non-positive ints, (404) for
 *     Contacts owned by another household.
 *   - Cross-household txn lookup returns 404 (no data leak).
 *
 * Setup mirrors transactionRevisions.test.ts: isolated Postgres + two
 * non-superadmin households (A and B).
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
let userBId: number;
let accountAId: number;
let accountBId: number;
let testDb: PgTestDb;

async function createTxn(opts: {
  householdId: number;
  accountId: number;
  counterpartyRaw: string | null;
  merchantRaw?: string;
  createdByUserId?: number | null;
}): Promise<number> {
  const models = await import('../../src/models');
  const row = await models.Transaction.create({
    accountId: opts.accountId,
    householdId: opts.householdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'cp-promote-test',
    date: '2026-09-01',
    merchantRaw: opts.merchantRaw ?? 'INTERAC E-TFR FROM JANE DOE',
    merchantClean: opts.merchantRaw ?? 'INTERAC E-TFR FROM JANE DOE',
    merchantCanonical: null,
    amount: '100.0000',
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
    myShareAmount: '100',
    partnerShareAmount: '0',
    businessAmount: '0',
    txnType: 'purchase',
    autoSource: null,
    autoConfidence: null,
    linkedTransactionId: null,
    isRecurring: false,
    reviewFlag: false,
    reviewedAt: null,
    createdByUserId: opts.createdByUserId ?? null,
    counterpartyRaw: opts.counterpartyRaw,
    counterpartyContactId: null,
  });
  return row.id;
}

before(async () => {
  testDb = await setupPgTestDb('cppromote');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const superAgent = testAgent(app);
  const register = await superAgent.post('/api/auth/register').send({
    email: 'super-cppromote@example.com',
    displayName: 'Super CPPromote',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const a = await seedHousehold('CPPromoteA', 'A Partner');
  householdAId = a.householdId;
  userAId = a.userId;
  agentA = testAgent(app);
  agentA.jar.setCookie(`cashflow_session=${a.token}; Path=/`);

  const b = await seedHousehold('CPPromoteB', 'B Partner');
  householdBId = b.householdId;
  userBId = b.userId;
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
    shortCode: 'CPA-CHQ',
  });
  accountAId = acctA.id;
  const acctB = await models.Account.create({
    householdId: householdBId,
    ownerUserId: userBId,
    owner: 'me',
    visibility: 'shared',
    name: 'B Chequing',
    accountType: 'checking',
    defaultCurrency: 'CAD',
    shortCode: 'CPB-CHQ',
  });
  accountBId = acctB.id;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('auto-create: creates new Contact from counterpartyRaw, links txn', async () => {
  const id = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    counterpartyRaw: 'JANE DOE',
  });
  const res = await agentA
    .post(`/api/transactions/${id}/counterparty/promote`)
    .send({});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.contact.name, 'JANE DOE');
  assert.equal(res.body.contact.householdId, householdAId);
  assert.equal(res.body.transaction.counterpartyContactId, res.body.contact.id);
  assert.equal(res.body.transaction.counterpartyRaw, 'JANE DOE');
});

test('auto-create: reuses existing Contact when name matches in household', async () => {
  const id1 = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    counterpartyRaw: 'SARAH KIM',
  });
  const first = await agentA
    .post(`/api/transactions/${id1}/counterparty/promote`)
    .send({});
  assert.equal(first.status, 200);
  const firstContactId = first.body.contact.id;

  const id2 = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    counterpartyRaw: 'SARAH KIM',
  });
  const second = await agentA
    .post(`/api/transactions/${id2}/counterparty/promote`)
    .send({});
  assert.equal(second.status, 200);
  assert.equal(
    second.body.contact.id,
    firstContactId,
    'second promote should reuse the existing Contact row',
  );
});

test('explicit contactId: links to caller-household Contact', async () => {
  const models = await import('../../src/models');
  const existing = await models.Contact.create({
    householdId: householdAId,
    name: 'BOB JONES (manual)',
    notes: null,
  });
  const id = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    counterpartyRaw: null,
  });
  const res = await agentA
    .post(`/api/transactions/${id}/counterparty/promote`)
    .send({ contactId: existing.id });
  assert.equal(res.status, 200);
  assert.equal(res.body.contact.id, existing.id);
  assert.equal(res.body.transaction.counterpartyContactId, existing.id);
});

test('auto-create: 400 when counterpartyRaw is null and no contactId provided', async () => {
  const id = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    counterpartyRaw: null,
  });
  const res = await agentA
    .post(`/api/transactions/${id}/counterparty/promote`)
    .send({});
  assert.equal(res.status, 400);
});

test('explicit contactId: 400 for non-positive int', async () => {
  const id = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    counterpartyRaw: 'JANE DOE',
  });
  const res = await agentA
    .post(`/api/transactions/${id}/counterparty/promote`)
    .send({ contactId: 0 });
  assert.equal(res.status, 400);
});

test('explicit contactId: 404 when Contact owned by another household', async () => {
  const models = await import('../../src/models');
  const foreign = await models.Contact.create({
    householdId: householdBId,
    name: 'B Foreign Contact',
    notes: null,
  });
  const id = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    counterpartyRaw: 'JANE DOE',
  });
  const res = await agentA
    .post(`/api/transactions/${id}/counterparty/promote`)
    .send({ contactId: foreign.id });
  assert.equal(res.status, 404);
});

test('cross-household txn lookup returns 404 (no data leak)', async () => {
  const id = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    counterpartyRaw: 'JANE DOE',
  });
  const res = await agentB
    .post(`/api/transactions/${id}/counterparty/promote`)
    .send({});
  assert.equal(res.status, 404);
});

test('invalid txn id returns 400', async () => {
  const res = await agentA
    .post(`/api/transactions/abc/counterparty/promote`)
    .send({});
  assert.equal(res.status, 400);
});
