/**
 * Integration tests for /api/categories. Run in isolation
 * (`yarn test:integration`) so DATABASE_URL is set before any Sequelize import.
 *
 * Mirrors budgets.test.ts: bootstrap a superadmin, then seed two non-superadmin
 * households so cross-household isolation can be exercised via real session cookies.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
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
  testDb = await setupPgTestDb('categories');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const bootstrap = request.agent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin-cats@example.com',
    displayName: 'Super Admin Cats',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const primary = await seed('PrimaryCat');
  primaryHouseholdId = primary.householdId;
  primaryAgent = request.agent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('OtherCat');
  otherHouseholdId = other.householdId;
  otherAgent = request.agent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

async function seedCategory(householdId: number, name: string, icon: string | null = null) {
  const models = await import('../../src/models');
  return models.Category.create({ householdId, name, icon });
}

test('GET /api/categories returns rows for current household only', async () => {
  await seedCategory(primaryHouseholdId, 'Coffee', 'Coffee');
  await seedCategory(primaryHouseholdId, 'Rent');
  await seedCategory(otherHouseholdId, 'OtherOnly');

  const res = await primaryAgent.get('/api/categories');
  assert.equal(res.status, 200);
  const names = res.body.map((r: { name: string }) => r.name);
  assert.deepEqual(names, ['Coffee', 'Rent']);
});

test('PATCH /api/categories/:id sets icon to a valid lucide name', async () => {
  const row = await seedCategory(primaryHouseholdId, 'Travel');
  const res = await primaryAgent
    .patch(`/api/categories/${row.id}`)
    .send({ icon: 'Plane' });
  assert.equal(res.status, 200);
  assert.equal(res.body.icon, 'Plane');
});

test('PATCH /api/categories/:id accepts null to clear icon', async () => {
  const row = await seedCategory(primaryHouseholdId, 'Books', 'BookOpen');
  const res = await primaryAgent
    .patch(`/api/categories/${row.id}`)
    .send({ icon: null });
  assert.equal(res.status, 200);
  assert.equal(res.body.icon, null);
});

test('PATCH /api/categories/:id rejects unknown icon name', async () => {
  const row = await seedCategory(primaryHouseholdId, 'Misc');
  const res = await primaryAgent
    .patch(`/api/categories/${row.id}`)
    .send({ icon: 'NotARealIcon' });
  assert.equal(res.status, 400);
});

test('PATCH /api/categories/:id 400s when icon field missing', async () => {
  const row = await seedCategory(primaryHouseholdId, 'NoBody');
  const res = await primaryAgent
    .patch(`/api/categories/${row.id}`)
    .send({});
  assert.equal(res.status, 400);
  assert.match(res.body.error ?? '', /icon field required/);
});

test('PATCH /api/categories/:id 404s for another household', async () => {
  const otherRow = await seedCategory(otherHouseholdId, 'Forbidden');
  const res = await primaryAgent
    .patch(`/api/categories/${otherRow.id}`)
    .send({ icon: 'Lock' });
  // Note: 'Lock' not in whitelist either — but the household check fires first.
  assert.equal(res.status, 404);
});
