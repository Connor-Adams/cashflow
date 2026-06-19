/**
 * Integration tests for /api/labels (issue #270). Run in isolation
 * (`yarn test:integration`) so DATABASE_URL is set before any Sequelize import.
 *
 * Mirrors categories.test.ts: bootstrap a superadmin, then seed two
 * non-superadmin households so cross-household isolation is exercised via real
 * session cookies.
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
let otherAgent: ReturnType<typeof request.agent>;
let otherHouseholdId: number;
let testDb: PgTestDb;

type Seeded = { token: string; householdId: number; userId: number };

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
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });
  return { token, householdId: household.id, userId: user.id };
}

before(async () => {
  testDb = await setupPgTestDb('labels');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const bootstrap = testAgent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin-labels@example.com',
    displayName: 'Super Admin Labels',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const primary = await seed('PrimaryLabel');
  primaryHouseholdId = primary.householdId;
  primaryAgent = testAgent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('OtherLabel');
  otherHouseholdId = other.householdId;
  otherAgent = testAgent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('POST /api/labels creates a label (AC #2 happy path)', async () => {
  const res = await primaryAgent.post('/api/labels').send({ name: 'tax-deductible' });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'tax-deductible');
  assert.equal(res.body.usageCount, 0);
  assert.ok(typeof res.body.id === 'number');
});

test('POST /api/labels rejects a case-only duplicate with 400 DUPLICATE_LABEL (AC #2)', async () => {
  const res = await primaryAgent.post('/api/labels').send({ name: 'Tax-Deductible' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'DUPLICATE_LABEL');
});

test('POST /api/labels rejects an over-length name with 400 INVALID_LABEL_NAME (AC #3)', async () => {
  const res = await primaryAgent.post('/api/labels').send({ name: 'a'.repeat(33) });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'INVALID_LABEL_NAME');
});

test('POST /api/labels rejects an empty-after-trim name with 400 INVALID_LABEL_NAME (AC #3)', async () => {
  const res = await primaryAgent.post('/api/labels').send({ name: '   ' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'INVALID_LABEL_NAME');
});

test('POST /api/labels accepts exactly 32 chars and trims whitespace', async () => {
  const core = 'x'.repeat(32);
  const res = await primaryAgent.post('/api/labels').send({ name: `  ${core}  ` });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, core);
});

test('GET /api/labels returns the household labels with usageCount, scoped to the household (AC #4)', async () => {
  await otherAgent.post('/api/labels').send({ name: 'other-household-only' });

  const res = await primaryAgent.get('/api/labels');
  assert.equal(res.status, 200);
  const names = res.body.map((r: { name: string }) => r.name);
  assert.ok(names.includes('tax-deductible'));
  assert.ok(!names.includes('other-household-only'), 'must not leak another household label');
  for (const row of res.body) {
    assert.equal(typeof row.usageCount, 'number');
  }
});

test('PATCH /api/labels/:id renames; case-only collision with another label is 400 (AC #2)', async () => {
  const a = await primaryAgent.post('/api/labels').send({ name: 'review-later' });
  assert.equal(a.status, 201);
  const b = await primaryAgent.post('/api/labels').send({ name: 'vacation-2026' });
  assert.equal(b.status, 201);

  // rename b to a case variant of a → collision
  const clash = await primaryAgent
    .patch(`/api/labels/${b.body.id}`)
    .send({ name: 'Review-Later' });
  assert.equal(clash.status, 400);
  assert.equal(clash.body.error, 'DUPLICATE_LABEL');

  // rename b to a fresh name → ok
  const ok = await primaryAgent
    .patch(`/api/labels/${b.body.id}`)
    .send({ name: 'holiday-2026' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.name, 'holiday-2026');
});

test('PATCH allows renaming a label to a case variant of itself', async () => {
  const a = await primaryAgent.post('/api/labels').send({ name: 'business-meal' });
  assert.equal(a.status, 201);
  const res = await primaryAgent
    .patch(`/api/labels/${a.body.id}`)
    .send({ name: 'Business-Meal' });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Business-Meal');
});

test('PATCH /api/labels/:id 404s for another household', async () => {
  const other = await otherAgent.post('/api/labels').send({ name: 'forbidden-rename' });
  assert.equal(other.status, 201);
  const res = await primaryAgent
    .patch(`/api/labels/${other.body.id}`)
    .send({ name: 'hijacked' });
  assert.equal(res.status, 404);
});

test('DELETE /api/labels/:id removes the label; 404 for another household', async () => {
  const a = await primaryAgent.post('/api/labels').send({ name: 'temp-delete-me' });
  assert.equal(a.status, 201);
  const del = await primaryAgent.delete(`/api/labels/${a.body.id}`);
  assert.equal(del.status, 204);
  const after = await primaryAgent.get('/api/labels');
  assert.ok(!after.body.map((r: { name: string }) => r.name).includes('temp-delete-me'));

  const other = await otherAgent.post('/api/labels').send({ name: 'other-delete' });
  const forbidden = await primaryAgent.delete(`/api/labels/${other.body.id}`);
  assert.equal(forbidden.status, 404);
});

test('POST /api/labels/:id/merge-into/:targetId repoints rows then deletes the source (AC #8)', async () => {
  // Set up two labels and a transaction tagged with both source and target,
  // plus a transaction tagged with source only. After merge: source gone, the
  // source-only txn now points at target, and the both-tagged txn keeps a
  // single target row (conflict-skip, no duplicate PK).
  const models = await import('../../src/models');

  const acc = await primaryAgent.post('/api/accounts').send({
    name: 'Merge Account',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  const accountId = acc.body.id as number;

  const csv = 'Date,Description,Amount\n2025-06-01,Merge Cafe,-5.50\n2025-06-02,Merge Shop,-3.00\n';
  const imp = await primaryAgent
    .post('/api/import/upload')
    .field('accountId', String(accountId))
    .field('profileId', 'generic_simple')
    .field('batchLabel', 'merge-batch')
    .attach('file', Buffer.from(csv, 'utf8'), { filename: 'm.csv', contentType: 'text/csv' });
  assert.equal(imp.status, 200);

  const list = await primaryAgent.get('/api/transactions?pageSize=25&importBatch=merge-batch');
  const txnIds = (list.body.data as { id: number }[]).map((t) => t.id);
  assert.ok(txnIds.length >= 2);
  const [txnBoth, txnSourceOnly] = txnIds;

  const src = await primaryAgent.post('/api/labels').send({ name: 'merge-source' });
  const tgt = await primaryAgent.post('/api/labels').send({ name: 'merge-target' });
  const sourceId = src.body.id as number;
  const targetId = tgt.body.id as number;

  await models.TransactionLabel.bulkCreate([
    { transactionId: txnBoth, labelId: sourceId },
    { transactionId: txnBoth, labelId: targetId },
    { transactionId: txnSourceOnly, labelId: sourceId },
  ]);

  const merge = await primaryAgent.post(`/api/labels/${sourceId}/merge-into/${targetId}`);
  assert.equal(merge.status, 200);
  assert.equal(merge.body.merged, true);

  // source label is gone
  const sourceRow = await models.Label.findByPk(sourceId);
  assert.equal(sourceRow, null);

  // target now linked to BOTH transactions, exactly once each
  const targetLinks = await models.TransactionLabel.findAll({ where: { labelId: targetId } });
  const linkedTxns = targetLinks.map((r) => r.transactionId).sort((a, b) => a - b);
  assert.deepEqual(linkedTxns, [txnBoth, txnSourceOnly].sort((a, b) => a - b));

  // no orphaned source rows remain
  const sourceLinks = await models.TransactionLabel.findAll({ where: { labelId: sourceId } });
  assert.equal(sourceLinks.length, 0);
});

test('merge into self is rejected with 400', async () => {
  const a = await primaryAgent.post('/api/labels').send({ name: 'self-merge' });
  const id = a.body.id as number;
  const res = await primaryAgent.post(`/api/labels/${id}/merge-into/${id}`);
  assert.equal(res.status, 400);
});

test('merge 404s when a label belongs to another household', async () => {
  const mine = await primaryAgent.post('/api/labels').send({ name: 'mine-merge' });
  const theirs = await otherAgent.post('/api/labels').send({ name: 'theirs-merge' });
  const res = await primaryAgent.post(
    `/api/labels/${mine.body.id}/merge-into/${theirs.body.id}`,
  );
  assert.equal(res.status, 404);
});
