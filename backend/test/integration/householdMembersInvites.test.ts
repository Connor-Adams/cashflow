/**
 * Integration tests for the #281 household invite UI backend surface:
 *   - GET    /api/household/members
 *   - DELETE /api/household/members/:userId
 *   - GET    /api/invites?status=pending
 *   - POST   /api/invites
 *   - DELETE /api/invites/:id
 *
 * Mirrors the auth + Postgres bootstrap used by contacts.test.ts: register a
 * bootstrap superadmin, then seed two independent households (A, B) via the
 * shared `seedHousehold` helper, and exercise both the happy paths and the
 * household-scoping isolation contract (AC #11).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { seedHousehold } from '../helpers/seedHousehold.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let models: typeof import('../../src/models');
let agentA: ReturnType<typeof request.agent>;
let agentB: ReturnType<typeof request.agent>;
let householdAId: number;
let ownerAUserId: number;
let testDb: PgTestDb;

before(async () => {
  process.env.NODE_ENV = 'test';
  testDb = await setupPgTestDb('household_members_invites');

  const mod = await import('../../src/app.js');
  app = mod.default;
  models = await import('../../src/models');

  const bootstrap = request.agent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin-members@example.com',
    displayName: 'SuperM',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const a = await seedHousehold('MA', 'A Original');
  householdAId = a.householdId;
  ownerAUserId = a.userId;
  agentA = request.agent(app);
  agentA.jar.setCookie(`cashflow_session=${a.token}; Path=/`);

  const b = await seedHousehold('MB', 'B Original');
  agentB = request.agent(app);
  agentB.jar.setCookie(`cashflow_session=${b.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// ─── Members ─────────────────────────────────────────────────────────────────

test('GET /api/household/members returns the seeded owner (AC #2, #11)', async () => {
  const res = await agentA.get('/api/household/members');
  assert.equal(res.status, 200);
  const rows = res.body as Array<{
    id: number;
    displayName: string;
    email: string;
    role: string;
    joinedAt: string;
  }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, ownerAUserId);
  assert.equal(rows[0].role, 'owner');
  assert.ok(rows[0].email.includes('@'));
});

test('GET /api/household/members is household-scoped (AC #11)', async () => {
  // Household B must only ever see its own owner, never household A's.
  const res = await agentB.get('/api/household/members');
  assert.equal(res.status, 200);
  const rows = res.body as Array<{ id: number }>;
  assert.ok(!rows.some((r) => r.id === ownerAUserId));
});

test('GET /api/household/members returns 401 when unauthenticated', async () => {
  const res = await request(app).get('/api/household/members');
  assert.equal(res.status, 401);
});

test('DELETE /api/household/members/:userId blocks owner self-removal (AC #10)', async () => {
  const res = await agentA.delete(`/api/household/members/${ownerAUserId}`);
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.error, "You can't revoke your own owner membership.");
  // Owner is still a member.
  const after = await agentA.get('/api/household/members');
  assert.ok((after.body as Array<{ id: number }>).some((r) => r.id === ownerAUserId));
});

test('DELETE /api/household/members/:userId removes a non-owner member (AC #9)', async () => {
  // Add a second, non-owner member directly so we can remove them.
  const extra = await models.User.create({
    email: `member-${Date.now()}@example.com`,
    displayName: 'Second Member',
    globalRole: 'user',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: 'x',
  });
  await models.HouseholdMember.create({
    householdId: householdAId,
    userId: extra.id,
    role: 'member',
  });

  const before = await agentA.get('/api/household/members');
  assert.equal((before.body as unknown[]).length, 2);

  const del = await agentA.delete(`/api/household/members/${extra.id}`);
  assert.equal(del.status, 204);

  const afterList = await agentA.get('/api/household/members');
  assert.ok(!(afterList.body as Array<{ id: number }>).some((r) => r.id === extra.id));
});

test('DELETE /api/household/members/:userId is household-scoped (404 cross-household)', async () => {
  // B cannot remove A's owner — A's owner is not a member of B's household.
  const res = await agentB.delete(`/api/household/members/${ownerAUserId}`);
  assert.equal(res.status, 404);
});

// ─── Invites ─────────────────────────────────────────────────────────────────

test('POST /api/invites creates an invite and returns a raw token (AC #5)', async () => {
  const res = await agentA.post('/api/invites').send({});
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(typeof res.body.token === 'string' && res.body.token.length > 0);
  assert.ok(typeof res.body.id === 'number');
  assert.ok(res.body.generatedAt);
  assert.ok(res.body.expiresAt);
  // The raw token must NOT be the stored hash.
  assert.equal(res.body.tokenFragment.length, 6);
});

test('POST /api/invites records a valid optionalEmail', async () => {
  const res = await agentA.post('/api/invites').send({ optionalEmail: 'spouse@example.com' });
  assert.equal(res.status, 201);
  assert.equal(res.body.optionalEmail, 'spouse@example.com');
});

test('POST /api/invites rejects an invalid optionalEmail (400)', async () => {
  const res = await agentA.post('/api/invites').send({ optionalEmail: 'not-an-email' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /optionalEmail must be a valid email/);
});

test('GET /api/invites?status=pending lists pending invites, scoped (AC #7, #11)', async () => {
  // A already created invites above; confirm they surface for A only.
  const res = await agentA.get('/api/invites?status=pending');
  assert.equal(res.status, 200);
  const rows = res.body as Array<{
    id: number;
    tokenFragment: string;
    generatedAt: string;
    optionalEmail: string | null;
  }>;
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((r) => r.tokenFragment.length === 6));
  // No raw token leaks in the list payload.
  assert.ok(rows.every((r) => !('token' in r)));

  // Household B sees none of A's invites.
  const bRes = await agentB.get('/api/invites?status=pending');
  assert.equal(bRes.status, 200);
  assert.equal((bRes.body as unknown[]).length, 0);
});

test('DELETE /api/invites/:id revokes and excludes from subsequent list (AC #8)', async () => {
  const created = await agentA.post('/api/invites').send({});
  assert.equal(created.status, 201);
  const id = created.body.id as number;

  const del = await agentA.delete(`/api/invites/${id}`);
  assert.equal(del.status, 204);

  const list = await agentA.get('/api/invites?status=pending');
  assert.ok(!(list.body as Array<{ id: number }>).some((r) => r.id === id));
});

test('DELETE /api/invites/:id is household-scoped (404 cross-household)', async () => {
  const created = await agentA.post('/api/invites').send({});
  const id = created.body.id as number;
  // B must not be able to revoke A's invite.
  const del = await agentB.delete(`/api/invites/${id}`);
  assert.equal(del.status, 404);
  // Still present for A.
  const list = await agentA.get('/api/invites?status=pending');
  assert.ok((list.body as Array<{ id: number }>).some((r) => r.id === id));
});

test('POST /api/invites returns 401 when unauthenticated', async () => {
  const res = await request(app).post('/api/invites').send({});
  assert.equal(res.status, 401);
});

// ─── Regression: legacy POST /api/auth/invites still works (AC #12) ───────────

test('legacy POST /api/auth/invites is unchanged and still issues a token (AC #12)', async () => {
  const res = await agentA.post('/api/auth/invites').send({});
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(typeof res.body.token === 'string' && res.body.token.length > 0);
  assert.ok(res.body.expiresAt);
});
