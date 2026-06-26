/**
 * Integration tests for the finance audit log (Cashflow #228).
 *
 * Verifies:
 *   - Mutating PATCH /api/transactions/:id emits a transaction.updated row
 *     scoped to the caller's household with a before/after diff.
 *   - Bulk-patch emits a transaction.bulk_updated row with affected ids.
 *   - Rule create / update / delete each emit one audit row.
 *   - Settlement create / delete emit one audit row each.
 *   - GET /api/audit-log filters by entityType, action, dateFrom/dateTo,
 *     and paginates.
 *   - GET /api/audit-log/transactions/:id returns history scoped to one
 *     transaction, with household isolation enforced.
 *   - Cross-household reads are blocked (404 / empty list).
 *
 * Mirrors the bootstrap pattern used by other integration tests.
 */
// Raise the AI rate-limit ceiling BEFORE the app (and thus `aiRateLimit.ts`,
// whose limiter reads this env once at construction) is imported in `before()`.
// The audit-log routes share `aiSuggestLimiter` (per-IP), and this file makes
// many audit-log GETs from a single supertest IP; the default max (20/min)
// would otherwise 429 legitimate test traffic and make the suite flaky.
process.env.AI_RATE_LIMIT_MAX = '1000';

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
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
    importBatch: 'audit-log-test',
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
  testDb = await setupPgTestDb('audit-log');

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
  primaryUserId = primary.userId;
  primaryAccountId = primary.accountId;
  primaryContactId = primary.contactId;
  primaryAgent = testAgent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('Other');
  otherAgent = testAgent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('PATCH /api/transactions/:id emits transaction.updated audit row with diff', async () => {
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
    `/api/audit-log?entityType=transaction&entityId=${txnId}`,
  );
  assert.equal(list.status, 200);
  const items = list.body.items as Array<{
    action: string;
    entityId: number;
    actorUserId: number | null;
    actorDisplayName: string | null;
    summary: string;
    after: Record<string, unknown> | null;
  }>;
  assert.ok(items.length >= 1, 'expected at least one audit row');
  const updated = items.find((i) => i.action === 'transaction.updated');
  assert.ok(updated, 'expected transaction.updated row');
  assert.equal(updated!.entityId, txnId);
  assert.equal(updated!.actorUserId, primaryUserId);
  assert.equal(updated!.actorDisplayName, 'Primary');
  assert.ok(updated!.summary?.startsWith('Updated'));
  const after = updated!.after ?? {};
  assert.equal((after as Record<string, unknown>).categoryOverride, 'Food');
  assert.equal((after as Record<string, unknown>).notes, 'lunch');
});

test('Bulk-patch emits one transaction.bulk_updated row with affected ids', async () => {
  const id1 = await seedTransaction({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    userId: primaryUserId,
  });
  const id2 = await seedTransaction({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    userId: primaryUserId,
  });

  const before = await primaryAgent.get(
    `/api/audit-log?action=transaction.bulk_updated`,
  );
  const beforeCount = before.body.items.length;

  const bulk = await primaryAgent
    .post('/api/transactions/bulk-patch')
    .send({ ids: [id1, id2], patch: { categoryOverride: 'Bulk' } });
  assert.equal(bulk.status, 200);

  const after = await primaryAgent.get(
    `/api/audit-log?action=transaction.bulk_updated`,
  );
  const items = after.body.items as Array<{
    summary: string;
    metadata: { ids: number[]; count: number } | null;
  }>;
  assert.equal(items.length, beforeCount + 1);
  const newest = items[0];
  assert.ok(newest.summary?.includes('2 transaction'));
  assert.equal(newest.metadata?.count, 2);
  assert.deepEqual(new Set(newest.metadata?.ids ?? []), new Set([id1, id2]));
});

test('Rule create / update / delete each emit one audit row', async () => {
  const create = await primaryAgent.post('/api/rules').send({
    merchantPattern: 'AUDIT-COFFEE',
    matchKind: 'substring',
    category: 'Coffee',
  });
  assert.equal(create.status, 201);
  const ruleId = create.body.id;

  const update = await primaryAgent
    .patch(`/api/rules/${ruleId}`)
    .send({ category: 'Cafe' });
  assert.equal(update.status, 200);

  const list = await primaryAgent.get(
    `/api/audit-log?entityType=rule&entityId=${ruleId}`,
  );
  const items = list.body.items as Array<{ action: string }>;
  const actions = items.map((i) => i.action).sort();
  assert.ok(actions.includes('rule.created'));
  assert.ok(actions.includes('rule.updated'));

  const del = await primaryAgent.delete(`/api/rules/${ruleId}`);
  assert.equal(del.status, 204);

  // After delete, entity-id query still returns historical rows.
  const list2 = await primaryAgent.get(
    `/api/audit-log?entityType=rule&entityId=${ruleId}`,
  );
  const actions2 = (list2.body.items as Array<{ action: string }>).map((i) => i.action);
  assert.ok(actions2.includes('rule.deleted'));
});

test('Settlement create + delete each emit one audit row', async () => {
  const create = await primaryAgent.post('/api/settlements').send({
    contactId: primaryContactId,
    direction: 'partner_paid_me',
    currency: 'CAD',
    amount: '25.00',
    settledDate: new Date().toISOString().slice(0, 10),
  });
  assert.equal(create.status, 201);
  const settlementId = create.body.id;

  const list = await primaryAgent.get(
    `/api/audit-log?entityType=settlement&entityId=${settlementId}`,
  );
  const items = list.body.items as Array<{ action: string }>;
  assert.ok(items.some((i) => i.action === 'settlement.created'));

  const del = await primaryAgent.delete(`/api/settlements/${settlementId}`);
  assert.equal(del.status, 204);

  const list2 = await primaryAgent.get(
    `/api/audit-log?entityType=settlement&entityId=${settlementId}`,
  );
  const actions = (list2.body.items as Array<{ action: string }>).map((i) => i.action);
  assert.ok(actions.includes('settlement.created'));
  assert.ok(actions.includes('settlement.deleted'));
});

test('GET /api/audit-log filters by action and supports pagination', async () => {
  // Create a stable batch of transaction.updated rows by patching the same
  // txn several times.
  const txnId = await seedTransaction({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    userId: primaryUserId,
  });
  for (let i = 0; i < 3; i += 1) {
    const res = await primaryAgent
      .patch(`/api/transactions/${txnId}`)
      .send({ notes: `iteration ${i}` });
    assert.equal(res.status, 200);
  }

  const page1 = await primaryAgent.get(
    `/api/audit-log?action=transaction.updated&entityType=transaction&entityId=${txnId}&limit=2&offset=0`,
  );
  assert.equal(page1.status, 200);
  assert.equal((page1.body.items as unknown[]).length, 2);
  assert.equal(page1.body.limit, 2);
  assert.equal(page1.body.offset, 0);
  assert.ok(page1.body.total >= 3);

  const page2 = await primaryAgent.get(
    `/api/audit-log?action=transaction.updated&entityType=transaction&entityId=${txnId}&limit=2&offset=2`,
  );
  assert.equal(page2.status, 200);
  assert.ok((page2.body.items as unknown[]).length >= 1);
});

test('GET /api/audit-log rejects invalid filters with 400', async () => {
  const bad = await primaryAgent.get('/api/audit-log?action=NOT VALID');
  assert.equal(bad.status, 400);
  const bad2 = await primaryAgent.get('/api/audit-log?entityId=abc');
  assert.equal(bad2.status, 400);
  const bad3 = await primaryAgent.get('/api/audit-log?dateFrom=not-a-date');
  assert.equal(bad3.status, 400);
});

test('GET /api/audit-log/transactions/:id returns history for that transaction only', async () => {
  const txnId = await seedTransaction({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    userId: primaryUserId,
  });
  await primaryAgent
    .patch(`/api/transactions/${txnId}`)
    .send({ categoryOverride: 'Special' });

  const hist = await primaryAgent.get(`/api/audit-log/transactions/${txnId}`);
  assert.equal(hist.status, 200);
  const items = hist.body.items as Array<{ entityId: number; entityType: string }>;
  assert.ok(items.length >= 1);
  for (const it of items) {
    assert.equal(it.entityType, 'transaction');
    assert.equal(Number(it.entityId), txnId);
  }
});

test('Audit rows do not leak across households (list)', async () => {
  // Other household must not see primary household's rows.
  const res = await otherAgent.get('/api/audit-log?limit=200');
  assert.equal(res.status, 200);
  const items = res.body.items as Array<{ entityId: number | null }>;
  // Other household has not performed any mutations (only seed-time creates),
  // so its audit log is empty.
  assert.equal(items.length, 0);
});

test('Audit transaction-history endpoint 404s across households', async () => {
  const txnId = await seedTransaction({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    userId: primaryUserId,
  });
  const res = await otherAgent.get(`/api/audit-log/transactions/${txnId}`);
  assert.equal(res.status, 404);
});

/**
 * Add a SECOND member to an existing household and return an authed agent +
 * userId for them. Used to prove intra-household row-level visibility (#838):
 * a member must not read another member's PRIVATE transaction edits through
 * the audit log even though both share the household scope.
 */
async function seedHouseholdMember(args: {
  householdId: number;
  emailPrefix: string;
}): Promise<{ agent: ReturnType<typeof request.agent>; userId: number }> {
  const models = await import('../../src/models');
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `${args.emailPrefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    displayName: args.emailPrefix,
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  await models.HouseholdMember.create({
    householdId: args.householdId,
    userId: user.id,
    role: 'member',
  });
  const token = crypto.randomBytes(32).toString('hex');
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
  });
  const agent = testAgent(app);
  agent.jar.setCookie(`cashflow_session=${token}; Path=/`);
  return { agent, userId: user.id };
}

async function seedPrivateTransaction(args: {
  householdId: number;
  accountId: number;
  userId: number;
  notes: string;
}): Promise<number> {
  const models = await import('../../src/models');
  const row = await models.Transaction.create({
    accountId: args.accountId,
    householdId: args.householdId,
    visibility: 'private',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'audit-log-test-private',
    date: new Date().toISOString().slice(0, 10),
    merchantRaw: 'Secret Merchant',
    merchantClean: 'Secret Merchant',
    amount: '-99.0000',
    currency: 'CAD',
    notes: args.notes,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: null,
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

test('Member cannot read another member\'s PRIVATE transaction edit via audit list (#838)', async () => {
  // Owner (primaryUser) makes a private transaction and edits it, writing the
  // secret note into the audit before/after snapshot.
  const txnId = await seedPrivateTransaction({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    userId: primaryUserId,
    notes: 'PRIVATE-baseline',
  });
  const patch = await primaryAgent
    .patch(`/api/transactions/${txnId}`)
    .send({ notes: 'PRIVATE-SECRET-NOTE' });
  assert.equal(patch.status, 200);

  // A second member of the SAME household.
  const member = await seedHouseholdMember({
    householdId: primaryHouseholdId,
    emailPrefix: 'Member838',
  });

  // The owner still sees their own private row's audit detail.
  const ownerList = await primaryAgent.get(
    `/api/audit-log?entityType=transaction&entityId=${txnId}`,
  );
  assert.equal(ownerList.status, 200);
  assert.ok(
    (ownerList.body.items as unknown[]).length >= 1,
    'owner should see their own private-row audit history',
  );

  // The other member must NOT see any audit row for that private transaction,
  // and must never receive the secret note.
  const memberList = await member.agent.get(
    `/api/audit-log?entityType=transaction&entityId=${txnId}`,
  );
  assert.equal(memberList.status, 200);
  assert.equal(
    (memberList.body.items as unknown[]).length,
    0,
    'member must not see a private (non-owned) transaction audit row',
  );

  // Belt-and-suspenders: an unfiltered list must not leak the secret note.
  const memberAll = await member.agent.get('/api/audit-log?limit=200');
  assert.equal(memberAll.status, 200);
  assert.equal(
    JSON.stringify(memberAll.body).includes('PRIVATE-SECRET-NOTE'),
    false,
    'secret note from a private row must never appear in another member\'s audit list',
  );
});

test('Member is 404d on the per-transaction audit history of a private row (#838)', async () => {
  const txnId = await seedPrivateTransaction({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    userId: primaryUserId,
    notes: 'PRIVATE-detail',
  });
  await primaryAgent.patch(`/api/transactions/${txnId}`).send({ notes: 'x' });

  const member = await seedHouseholdMember({
    householdId: primaryHouseholdId,
    emailPrefix: 'Member838b',
  });
  const res = await member.agent.get(`/api/audit-log/transactions/${txnId}`);
  assert.equal(res.status, 404, 'private transaction history must 404 for a non-owner member');

  // The owner still gets it.
  const ownerRes = await primaryAgent.get(`/api/audit-log/transactions/${txnId}`);
  assert.equal(ownerRes.status, 200);
});

test('Member CAN read a SHARED transaction edit via audit log (no over-restriction) (#838)', async () => {
  const txnId = await seedTransaction({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    userId: primaryUserId,
  });
  await primaryAgent
    .patch(`/api/transactions/${txnId}`)
    .send({ categoryOverride: 'SharedCat' });

  const member = await seedHouseholdMember({
    householdId: primaryHouseholdId,
    emailPrefix: 'Member838c',
  });
  const list = await member.agent.get(
    `/api/audit-log?entityType=transaction&entityId=${txnId}`,
  );
  assert.equal(list.status, 200);
  assert.ok(
    (list.body.items as unknown[]).length >= 1,
    'shared-row audit history must remain visible to all household members',
  );
  const hist = await member.agent.get(`/api/audit-log/transactions/${txnId}`);
  assert.equal(hist.status, 200);
});
