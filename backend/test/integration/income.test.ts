/**
 * Integration tests for /api/income (issue #434).
 * Covers CRUD, validation, household isolation, and paired transaction creation.
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
let primaryUserId: number;
let otherAgent: ReturnType<typeof request.agent>;
let otherHouseholdId: number;
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
    name: `${emailPrefix} chequing`,
    accountType: 'chequing',
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

before(async () => {
  process.env.NODE_ENV = 'test';

  testDb = await setupPgTestDb('income_entries');

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
  primaryUserId = primary.userId;
  primaryAgent = request.agent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('Other');
  otherHouseholdId = other.householdId;
  otherAgent = request.agent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// ── create ──────────────────────────────────────────────────────────────────

test('POST /api/income creates an entry without tax withheld', async () => {
  const res = await primaryAgent.post('/api/income').send({
    occurredOn: '2026-03-01',
    grossAmountCents: 500000,
    currency: 'CAD',
    source: 'paycheck',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.householdId, primaryHouseholdId);
  assert.equal(res.body.userId, primaryUserId);
  assert.equal(res.body.occurredOn, '2026-03-01');
  assert.equal(Number(res.body.grossAmountCents), 500000);
  assert.equal(res.body.currency, 'CAD');
  assert.equal(res.body.source, 'paycheck');
  assert.equal(res.body.taxWithheldCents, null);
  assert.equal(Number(res.body.netAmountCents), 500000);
  assert.equal(res.body.linkedTransactionId, null);
});

test('POST /api/income creates an entry with tax withheld and computes net', async () => {
  const res = await primaryAgent.post('/api/income').send({
    occurredOn: '2026-03-15',
    grossAmountCents: 400000,
    currency: 'CAD',
    taxWithheldCents: 120000,
    source: 'invoice',
    notes: 'Project X',
  });
  assert.equal(res.status, 201);
  assert.equal(Number(res.body.grossAmountCents), 400000);
  assert.equal(Number(res.body.taxWithheldCents), 120000);
  assert.equal(Number(res.body.netAmountCents), 280000);
  assert.equal(res.body.notes, 'Project X');
});

test('POST /api/income creates a paired transaction when accountId provided', async () => {
  const res = await primaryAgent.post('/api/income').send({
    occurredOn: '2026-04-01',
    grossAmountCents: 300000,
    currency: 'CAD',
    taxWithheldCents: 60000,
    source: 'paycheck',
    accountId: primaryAccountId,
  });
  assert.equal(res.status, 201);
  const linkedTxnId = res.body.linkedTransactionId as number;
  assert.ok(linkedTxnId != null, 'should have a linked transaction');

  // Verify paired transaction via list with ids filter
  const txnRes = await primaryAgent.get(`/api/transactions?ids=${linkedTxnId}`);
  assert.equal(txnRes.status, 200);
  const txns = txnRes.body.data as Array<{
    id: number; accountId: number; txnType: string; amount: string; currency: string;
    date: string; merchantClean: string;
  }>;
  assert.equal(txns.length, 1);
  const txn = txns[0];
  assert.equal(txn.id, linkedTxnId);
  assert.equal(txn.accountId, primaryAccountId);
  assert.equal(txn.txnType, 'income');
  // net = (300000 - 60000) / 100 = 2400.00
  assert.equal(Number(txn.amount), 2400);
  assert.equal(txn.currency, 'CAD');
  assert.equal(txn.date, '2026-04-01');
  assert.match(txn.merchantClean, /Income \(paycheck\)/);
});

// ── validation ───────────────────────────────────────────────────────────────

test('POST /api/income rejects invalid date format', async () => {
  const res = await primaryAgent.post('/api/income').send({
    occurredOn: '01/03/2026',
    grossAmountCents: 100,
    currency: 'CAD',
    source: 'cash',
  });
  assert.equal(res.status, 400);
});

test('POST /api/income rejects non-positive grossAmountCents', async () => {
  const res = await primaryAgent.post('/api/income').send({
    occurredOn: '2026-03-01',
    grossAmountCents: 0,
    currency: 'CAD',
    source: 'cash',
  });
  assert.equal(res.status, 400);
});

test('POST /api/income rejects invalid currency', async () => {
  const res = await primaryAgent.post('/api/income').send({
    occurredOn: '2026-03-01',
    grossAmountCents: 100,
    currency: 'ca',
    source: 'cash',
  });
  assert.equal(res.status, 400);
});

test('POST /api/income rejects unknown source', async () => {
  const res = await primaryAgent.post('/api/income').send({
    occurredOn: '2026-03-01',
    grossAmountCents: 100,
    currency: 'CAD',
    source: 'lottery',
  });
  assert.equal(res.status, 400);
});

test('POST /api/income rejects tax exceeding gross', async () => {
  const res = await primaryAgent.post('/api/income').send({
    occurredOn: '2026-03-01',
    grossAmountCents: 100,
    currency: 'CAD',
    taxWithheldCents: 101,
    source: 'paycheck',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Tax/);
});

// ── list ─────────────────────────────────────────────────────────────────────

test('GET /api/income returns entries for the household ordered newest-first', async () => {
  // Create two more for known ordering
  await primaryAgent.post('/api/income').send({
    occurredOn: '2026-01-01',
    grossAmountCents: 1000,
    currency: 'CAD',
    source: 'cash',
  });
  await primaryAgent.post('/api/income').send({
    occurredOn: '2026-05-01',
    grossAmountCents: 2000,
    currency: 'CAD',
    source: 'gift',
  });

  const res = await primaryAgent.get('/api/income');
  assert.equal(res.status, 200);
  const entries = res.body.entries as Array<{ occurredOn: string }>;
  assert.ok(entries.length >= 2);
  for (let i = 1; i < entries.length; i++) {
    assert.ok(
      entries[i - 1].occurredOn >= entries[i].occurredOn,
      `expected DESC order: ${entries[i - 1].occurredOn} >= ${entries[i].occurredOn}`,
    );
  }
});

test('GET /api/income does not leak another household\'s entries', async () => {
  const otherRes = await otherAgent.post('/api/income').send({
    occurredOn: '2026-03-01',
    grossAmountCents: 99999,
    currency: 'CAD',
    source: 'other',
  });
  assert.equal(otherRes.status, 201);
  const otherId = otherRes.body.id as number;

  const primaryList = await primaryAgent.get('/api/income');
  const ids = (primaryList.body.entries as Array<{ id: number }>).map((e) => e.id);
  assert.ok(!ids.includes(otherId), 'primary should not see other household entry');
});

// ── update ───────────────────────────────────────────────────────────────────

test('PATCH /api/income/:id updates fields and recomputes net', async () => {
  const created = await primaryAgent.post('/api/income').send({
    occurredOn: '2026-06-01',
    grossAmountCents: 200000,
    currency: 'CAD',
    source: 'paycheck',
  });
  const id = created.body.id as number;

  const patched = await primaryAgent.patch(`/api/income/${id}`).send({
    taxWithheldCents: 50000,
    notes: 'June paycheck',
  });
  assert.equal(patched.status, 200);
  assert.equal(Number(patched.body.grossAmountCents), 200000);
  assert.equal(Number(patched.body.taxWithheldCents), 50000);
  assert.equal(Number(patched.body.netAmountCents), 150000);
  assert.equal(patched.body.notes, 'June paycheck');
});

test('PATCH /api/income/:id updates the paired transaction when present', async () => {
  const created = await primaryAgent.post('/api/income').send({
    occurredOn: '2026-06-15',
    grossAmountCents: 100000,
    currency: 'CAD',
    source: 'invoice',
    accountId: primaryAccountId,
  });
  const id = created.body.id as number;
  const linkedTxnId = created.body.linkedTransactionId as number;

  const patched = await primaryAgent.patch(`/api/income/${id}`).send({
    grossAmountCents: 120000,
    taxWithheldCents: 20000,
  });
  assert.equal(patched.status, 200);
  // income entry net = (120000 - 20000) / 100 = 1000.00
  assert.equal(Number(patched.body.netAmountCents), 100000);

  // Verify the paired transaction was updated
  const txnRes = await primaryAgent.get(`/api/transactions?ids=${linkedTxnId}`);
  assert.equal(txnRes.status, 200);
  const txns = txnRes.body.data as Array<{ id: number; amount: string }>;
  assert.equal(txns.length, 1);
  assert.equal(Number(txns[0].amount), 1000);
});

test('PATCH /api/income/:id 404s for another household', async () => {
  const otherCreated = await otherAgent.post('/api/income').send({
    occurredOn: '2026-03-01',
    grossAmountCents: 500,
    currency: 'CAD',
    source: 'cash',
  });
  const otherId = otherCreated.body.id as number;

  const sneak = await primaryAgent.patch(`/api/income/${otherId}`).send({
    notes: 'hacked',
  });
  assert.equal(sneak.status, 404);
});

// ── delete ───────────────────────────────────────────────────────────────────

test('DELETE /api/income/:id removes the entry', async () => {
  const created = await primaryAgent.post('/api/income').send({
    occurredOn: '2026-07-01',
    grossAmountCents: 1000,
    currency: 'CAD',
    source: 'cash',
  });
  const id = created.body.id as number;

  const del = await primaryAgent.delete(`/api/income/${id}`);
  assert.equal(del.status, 204);

  const list = await primaryAgent.get('/api/income');
  const ids = (list.body.entries as Array<{ id: number }>).map((e) => e.id);
  assert.ok(!ids.includes(id));
});

test('DELETE /api/income/:id removes the paired transaction', async () => {
  const created = await primaryAgent.post('/api/income').send({
    occurredOn: '2026-07-15',
    grossAmountCents: 5000,
    currency: 'CAD',
    source: 'paycheck',
    accountId: primaryAccountId,
  });
  const id = created.body.id as number;
  const linkedTxnId = created.body.linkedTransactionId as number;
  assert.ok(linkedTxnId != null);

  await primaryAgent.delete(`/api/income/${id}`);

  const txnRes = await primaryAgent.get(`/api/transactions/${linkedTxnId}`);
  assert.equal(txnRes.status, 404);
});

test('DELETE /api/income/:id 404s for another household', async () => {
  const otherCreated = await otherAgent.post('/api/income').send({
    occurredOn: '2026-03-01',
    grossAmountCents: 200,
    currency: 'CAD',
    source: 'other',
  });
  const otherId = otherCreated.body.id as number;

  const sneak = await primaryAgent.delete(`/api/income/${otherId}`);
  assert.equal(sneak.status, 404);
});

test('households are isolated: primaryHouseholdId differs from otherHouseholdId', () => {
  assert.notEqual(primaryHouseholdId, otherHouseholdId);
});
