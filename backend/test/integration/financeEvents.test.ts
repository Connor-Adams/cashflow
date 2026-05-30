/**
 * Integration tests for the finance domain event stream (Cashflow #238).
 *
 * Verifies:
 *   - Mutating PATCH /api/transactions/:id emits a transaction.updated
 *     finance_events row with a compact payload (changed keys + after).
 *   - Settlement create / delete each emit one finance_events row.
 *   - Rule create / update / delete each emit one finance_events row.
 *   - GET /api/finance-events filters by type and supports pagination.
 *   - GET /api/finance-events/entity/:entityType/:entityId returns the
 *     full event stream for one entity in replay order (ASC).
 *   - Cross-household reads are blocked (empty list, not leak).
 *
 * Mirrors the bootstrap pattern used by other integration tests.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let primaryAgent: ReturnType<typeof request.agent>;
let otherAgent: ReturnType<typeof request.agent>;
let primaryHouseholdId: number;
let primaryUserId: number;
let primaryAccountId: number;
let primaryContactId: number;
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
    name: `${emailPrefix} contact`,
    relation: 'roommate',
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

async function seedTransaction(args: {
  householdId: number;
  accountId: number;
  userId: number;
  category?: string | null;
}): Promise<number> {
  const models = await import('../../src/models');
  const row = await models.Transaction.create({
    accountId: args.accountId,
    householdId: args.householdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'finance-events-test',
    date: new Date().toISOString().slice(0, 10),
    merchantRaw: 'Test Merchant',
    merchantClean: 'Test Merchant',
    amount: '-10.0000',
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: args.category ?? null,
    finalCategory: args.category ?? null,
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
    createdByUserId: args.userId,
  });
  return row.id;
}

before(async () => {
  // aiSuggestLimiter is bypassed in NODE_ENV=test — set BEFORE the app
  // bootstraps so the rate limit doesn't return 429 across many calls.
  process.env.NODE_ENV = 'test';

  testDb = await setupPgTestDb('finance-events');

  const mod = await import('../../src/app.js');
  app = mod.default;

  // Bootstrap superadmin so subsequent /register calls aren't first-user
  // privileged paths.
  const bootstrap = request.agent(app);
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
  primaryContactId = primary.contactId;
  primaryAgent = request.agent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('Other');
  otherAgent = request.agent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('PATCH /api/transactions/:id emits transaction.updated finance event', async () => {
  const txnId = await seedTransaction({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    userId: primaryUserId,
  });

  const patch = await primaryAgent
    .patch(`/api/transactions/${txnId}`)
    .send({ categoryOverride: 'Food', notes: 'lunch' });
  assert.equal(patch.status, 200);

  const list = await primaryAgent.get(
    `/api/finance-events?type=transaction.updated&entityType=transaction&entityId=${txnId}`,
  );
  assert.equal(list.status, 200);
  const items = list.body.items as Array<{
    type: string;
    entityId: number;
    actorUserId: number | null;
    payload: { changed: string[]; after: Record<string, unknown> } | null;
  }>;
  assert.ok(items.length >= 1, 'expected at least one finance event');
  const event = items[0];
  assert.equal(event.type, 'transaction.updated');
  assert.equal(event.entityId, txnId);
  assert.equal(event.actorUserId, primaryUserId);
  assert.ok(event.payload, 'payload required');
  assert.ok(Array.isArray(event.payload!.changed));
  assert.ok(event.payload!.changed.includes('categoryOverride'));
  assert.ok(event.payload!.changed.includes('notes'));
  assert.equal(event.payload!.after.categoryOverride, 'Food');
  assert.equal(event.payload!.after.notes, 'lunch');
});

test('Settlement create + delete each emit one finance event', async () => {
  const create = await primaryAgent.post('/api/settlements').send({
    contactId: primaryContactId,
    direction: 'partner_paid_me',
    currency: 'CAD',
    amount: '25.00',
    settledDate: new Date().toISOString().slice(0, 10),
  });
  assert.equal(create.status, 201);
  const settlementId = create.body.id;

  const list1 = await primaryAgent.get(
    `/api/finance-events?entityType=settlement&entityId=${settlementId}`,
  );
  const items1 = list1.body.items as Array<{ type: string; payload: Record<string, unknown> | null }>;
  assert.ok(items1.some((i) => i.type === 'settlement.created'));
  const created = items1.find((i) => i.type === 'settlement.created');
  // DECIMAL(14,4) round-trips as "25.0000" — assert numeric equality, not
  // raw string equality, so we're robust to the column scale.
  const createdAmount = (created!.payload as Record<string, unknown>).amount;
  assert.equal(Number(createdAmount), 25);
  assert.equal((created!.payload as Record<string, unknown>).direction, 'partner_paid_me');

  const del = await primaryAgent.delete(`/api/settlements/${settlementId}`);
  assert.equal(del.status, 204);

  const list2 = await primaryAgent.get(
    `/api/finance-events?entityType=settlement&entityId=${settlementId}`,
  );
  const types = (list2.body.items as Array<{ type: string }>).map((i) => i.type);
  assert.ok(types.includes('settlement.created'));
  assert.ok(types.includes('settlement.deleted'));
});

test('Rule create / update / delete each emit one finance event', async () => {
  const create = await primaryAgent.post('/api/rules').send({
    merchantPattern: 'FINEVT-COFFEE',
    matchKind: 'substring',
    category: 'Coffee',
  });
  assert.equal(create.status, 201);
  const ruleId = create.body.id;

  const update = await primaryAgent
    .patch(`/api/rules/${ruleId}`)
    .send({ category: 'Cafe' });
  assert.equal(update.status, 200);

  const del = await primaryAgent.delete(`/api/rules/${ruleId}`);
  assert.equal(del.status, 204);

  const list = await primaryAgent.get(
    `/api/finance-events/entity/rule/${ruleId}`,
  );
  assert.equal(list.status, 200);
  const types = (list.body.items as Array<{ type: string }>).map((i) => i.type);
  // Replay order — ASC by createdAt.
  assert.deepEqual(types, ['rule.created', 'rule.updated', 'rule.deleted']);
});

test('GET /api/finance-events filters by type and supports pagination', async () => {
  // Create a stable batch of transaction.updated events by patching the
  // same transaction several times.
  const txnId = await seedTransaction({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    userId: primaryUserId,
  });
  for (let i = 0; i < 3; i += 1) {
    const res = await primaryAgent
      .patch(`/api/transactions/${txnId}`)
      .send({ notes: `iter-${i}` });
    assert.equal(res.status, 200);
  }

  const page1 = await primaryAgent.get(
    `/api/finance-events?type=transaction.updated&entityType=transaction&entityId=${txnId}&limit=2&offset=0`,
  );
  assert.equal(page1.status, 200);
  assert.equal((page1.body.items as unknown[]).length, 2);
  assert.equal(page1.body.limit, 2);
  assert.equal(page1.body.offset, 0);
  assert.ok(page1.body.total >= 3);

  const page2 = await primaryAgent.get(
    `/api/finance-events?type=transaction.updated&entityType=transaction&entityId=${txnId}&limit=2&offset=2`,
  );
  assert.equal(page2.status, 200);
  assert.ok((page2.body.items as unknown[]).length >= 1);
});

test('GET /api/finance-events rejects invalid filters with 400', async () => {
  const bad = await primaryAgent.get('/api/finance-events?type=NOT VALID');
  assert.equal(bad.status, 400);
  const bad2 = await primaryAgent.get('/api/finance-events?entityId=abc');
  assert.equal(bad2.status, 400);
  const bad3 = await primaryAgent.get('/api/finance-events?dateFrom=not-a-date');
  assert.equal(bad3.status, 400);
  const bad4 = await primaryAgent.get('/api/finance-events?order=sideways');
  assert.equal(bad4.status, 400);
});

test('GET /api/finance-events/entity/:type/:id returns ASC stream for one entity', async () => {
  const txnId = await seedTransaction({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    userId: primaryUserId,
  });
  await primaryAgent
    .patch(`/api/transactions/${txnId}`)
    .send({ categoryOverride: 'A' });
  await primaryAgent
    .patch(`/api/transactions/${txnId}`)
    .send({ categoryOverride: 'B' });
  await primaryAgent
    .patch(`/api/transactions/${txnId}`)
    .send({ categoryOverride: 'C' });

  const stream = await primaryAgent.get(
    `/api/finance-events/entity/transaction/${txnId}`,
  );
  assert.equal(stream.status, 200);
  const items = stream.body.items as Array<{
    type: string;
    payload: { after?: { categoryOverride?: string } } | null;
  }>;
  // All transaction.updated, in insertion order (ASC).
  for (const it of items) {
    assert.equal(it.type, 'transaction.updated');
  }
  const sequence = items
    .map((i) => i.payload?.after?.categoryOverride ?? null)
    .filter((v): v is string => typeof v === 'string');
  // The patch sequence A→B→C means we should observe them in that
  // chronological order.
  const aIdx = sequence.indexOf('A');
  const bIdx = sequence.indexOf('B');
  const cIdx = sequence.indexOf('C');
  assert.ok(aIdx >= 0 && bIdx >= 0 && cIdx >= 0);
  assert.ok(aIdx < bIdx);
  assert.ok(bIdx < cIdx);
});

test('Finance events do not leak across households', async () => {
  // The Other household has not performed mutations — their stream is empty.
  const res = await otherAgent.get('/api/finance-events?limit=200');
  assert.equal(res.status, 200);
  const items = res.body.items as Array<unknown>;
  assert.equal(items.length, 0);
});

test('Cross-household entity lookup returns empty (not leaks)', async () => {
  // A transaction id owned by primary should produce an empty stream
  // when queried as the other household — not 404, not the row.
  const txnId = await seedTransaction({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    userId: primaryUserId,
  });
  await primaryAgent
    .patch(`/api/transactions/${txnId}`)
    .send({ categoryOverride: 'Hidden' });

  const res = await otherAgent.get(
    `/api/finance-events/entity/transaction/${txnId}`,
  );
  assert.equal(res.status, 200);
  assert.equal((res.body.items as unknown[]).length, 0);
});
