/**
 * Integration tests for the in-app feedback route surface (issue #295),
 * exercised end-to-end against a real Postgres database:
 *   POST /api/feedback                 — create a submission (rate-limited)
 *   GET  /api/feedback                 — owner-only newest-first list
 *   POST /api/feedback/:id/resolve     — owner-only mark resolved
 *
 * Seeding mirrors reimbursements.test.ts. Most tests seed a fresh owner per
 * assertion so the 5/min per-user rate limit (which is NOT skipped in test,
 * unlike the other limiters) leaves headroom; the dedicated rate-limit test
 * fires 6 POSTs as one user and asserts the 6th is rejected.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let testDb: PgTestDb;

type Seeded = {
  agent: ReturnType<typeof request.agent>;
  householdId: number;
  userId: number;
};

/** Seed an owner with their own household + session, return an attached agent. */
async function seedOwner(prefix: string): Promise<Seeded> {
  const models = await import('../../src/models');
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    displayName: prefix,
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: `${prefix} household` });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  const token = crypto.randomBytes(32).toString('hex');
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
  });
  const agent = request.agent(app);
  agent.jar.setCookie(`cashflow_session=${token}; Path=/`);
  return { agent, householdId: household.id, userId: user.id };
}

/** Add a second user as a non-owner MEMBER of an existing household. */
async function seedMemberOf(prefix: string, householdId: number): Promise<Seeded> {
  const models = await import('../../src/models');
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    displayName: prefix,
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  await models.HouseholdMember.create({ householdId, userId: user.id, role: 'member' });
  const token = crypto.randomBytes(32).toString('hex');
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
  });
  const agent = request.agent(app);
  agent.jar.setCookie(`cashflow_session=${token}; Path=/`);
  return { agent, householdId, userId: user.id };
}

before(async () => {
  // Keep NODE_ENV=test for the rest of the app, but note: the feedback
  // limiter intentionally does NOT skip in test (issue #295 AC#5).
  process.env.NODE_ENV = 'test';
  delete process.env.FEEDBACK_WEBHOOK_URL;
  delete process.env.FEEDBACK_RATE_LIMIT_MAX;

  testDb = await setupPgTestDb('feedback');
  const mod = await import('../../src/app.js');
  app = mod.default;

  // First registered user becomes the superadmin bootstrap; subsequent seeds
  // use direct model writes.
  const bootstrap = request.agent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);
});

after(async () => {
  delete process.env.FEEDBACK_WEBHOOK_URL;
  await teardownPgTestDb(testDb);
});

test('POST /api/feedback writes a row scoped to the current user (AC#2)', async () => {
  const owner = await seedOwner('Writer');
  const res = await owner.agent
    .post('/api/feedback')
    .send({ category: 'bug', body: 'The dashboard chart is blank' });
  assert.equal(res.status, 201);
  assert.ok(typeof res.body.id === 'number');

  const models = await import('../../src/models');
  const row = await models.Feedback.findByPk(res.body.id);
  assert.ok(row);
  assert.equal(row!.userId, owner.userId);
  assert.equal(row!.householdId, owner.householdId);
  assert.equal(row!.category, 'bug');
  assert.equal(row!.body, 'The dashboard chart is blank');
  assert.equal(row!.resolvedAt, null);
});

test('POST captures the User-Agent header server-side (AC#2 context)', async () => {
  const owner = await seedOwner('UaWriter');
  const res = await owner.agent
    .post('/api/feedback')
    .set('User-Agent', 'TestBrowser/1.0')
    .send({ category: 'other', body: 'just a note here' });
  assert.equal(res.status, 201);
  const models = await import('../../src/models');
  const row = await models.Feedback.findByPk(res.body.id);
  assert.equal(row!.userAgent, 'TestBrowser/1.0');
});

test('POST with an invalid category returns 400 INVALID_CATEGORY (AC#3)', async () => {
  const owner = await seedOwner('BadCat');
  const res = await owner.agent
    .post('/api/feedback')
    .send({ category: 'rant', body: 'this is long enough' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'INVALID_CATEGORY');
});

test('POST with a too-short body returns 400 BODY_TOO_SHORT (AC#4)', async () => {
  const owner = await seedOwner('ShortBody');
  const res = await owner.agent
    .post('/api/feedback')
    .send({ category: 'bug', body: 'hi' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'BODY_TOO_SHORT');
});

test('POST with a too-long body returns 400 BODY_TOO_LONG (AC#4)', async () => {
  const owner = await seedOwner('LongBody');
  const res = await owner.agent
    .post('/api/feedback')
    .send({ category: 'bug', body: 'a'.repeat(2001) });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'BODY_TOO_LONG');
});

test('rate limits the 6th submission within the window with 429 RATE_LIMITED (AC#5)', async () => {
  const owner = await seedOwner('Flooder');
  for (let i = 0; i < 5; i++) {
    const ok = await owner.agent
      .post('/api/feedback')
      .send({ category: 'other', body: `submission number ${i}` });
    assert.equal(ok.status, 201, `submission ${i} should succeed`);
  }
  const sixth = await owner.agent
    .post('/api/feedback')
    .send({ category: 'other', body: 'one too many submissions' });
  assert.equal(sixth.status, 429);
  assert.equal(sixth.body.error, 'RATE_LIMITED');
});

test('GET /api/feedback lists newest-first and is owner-only (AC#6)', async () => {
  const owner = await seedOwner('Lister');
  // Two submissions; the second is newer.
  const first = await owner.agent
    .post('/api/feedback')
    .send({ category: 'bug', body: 'first submission body' });
  assert.equal(first.status, 201);
  const second = await owner.agent
    .post('/api/feedback')
    .send({ category: 'feature', body: 'second submission body' });
  assert.equal(second.status, 201);

  const list = await owner.agent.get('/api/feedback');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body.data));
  assert.ok(list.body.count >= 2);
  // Newest-first: the second submission's id comes before the first.
  const ids = list.body.data.map((r: { id: number }) => r.id);
  assert.ok(
    ids.indexOf(second.body.id) < ids.indexOf(first.body.id),
    'expected newest submission first',
  );
  // Serialized shape carries the context fields.
  const top = list.body.data[0];
  assert.ok('category' in top && 'body' in top && 'createdAt' in top);
});

test('GET /api/feedback returns 403 for a non-owner member (AC#6)', async () => {
  const owner = await seedOwner('OwnerHH');
  const member = await seedMemberOf('MemberHH', owner.householdId);
  const res = await member.agent.get('/api/feedback');
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'FORBIDDEN');
});

test('GET /api/feedback supports pagination via limit/offset (AC#6)', async () => {
  const owner = await seedOwner('Pager');
  for (let i = 0; i < 4; i++) {
    const r = await owner.agent
      .post('/api/feedback')
      .send({ category: 'other', body: `paged submission ${i}` });
    assert.equal(r.status, 201);
  }
  const page = await owner.agent.get('/api/feedback?limit=2&offset=0');
  assert.equal(page.status, 200);
  assert.equal(page.body.data.length, 2);
});

test('POST /api/feedback/:id/resolve sets resolved_at and is owner-only (AC#7)', async () => {
  const owner = await seedOwner('Resolver');
  const created = await owner.agent
    .post('/api/feedback')
    .send({ category: 'bug', body: 'please resolve me soon' });
  assert.equal(created.status, 201);

  // Non-owner member cannot resolve.
  const member = await seedMemberOf('ResolverMember', owner.householdId);
  const forbidden = await member.agent.post(`/api/feedback/${created.body.id}/resolve`);
  assert.equal(forbidden.status, 403);

  const res = await owner.agent.post(`/api/feedback/${created.body.id}/resolve`);
  assert.equal(res.status, 200);
  assert.ok(res.body.resolvedAt);

  const models = await import('../../src/models');
  const row = await models.Feedback.findByPk(created.body.id);
  assert.ok(row!.resolvedAt instanceof Date);
});

test('resolve returns 404 for another household\'s feedback', async () => {
  const a = await seedOwner('HouseA');
  const created = await a.agent
    .post('/api/feedback')
    .send({ category: 'bug', body: 'house A private note' });
  assert.equal(created.status, 201);
  const b = await seedOwner('HouseB');
  const res = await b.agent.post(`/api/feedback/${created.body.id}/resolve`);
  assert.equal(res.status, 404);
});

test('webhook fires on successful save and a failure does not 500 the POST (AC#8)', async () => {
  const owner = await seedOwner('Hooker');
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];

  // First: a webhook that rejects — the POST must still succeed.
  process.env.FEEDBACK_WEBHOOK_URL = 'https://hook.example/feedback';
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    throw new Error('network down');
  }) as unknown as typeof fetch;
  try {
    const res1 = await owner.agent
      .post('/api/feedback')
      .send({ category: 'feature', body: 'webhook failure should not block' });
    assert.equal(res1.status, 201, 'POST must succeed even when the webhook throws');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://hook.example/feedback');

    // Second: a webhook that succeeds — assert the sanitized payload shape.
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;
    const res2 = await owner.agent
      .post('/api/feedback')
      .send({ category: 'bug', body: 'webhook success payload check' });
    assert.equal(res2.status, 201);
    assert.equal(calls.length, 2);
    const payload = calls[1].body as Record<string, unknown>;
    assert.equal(payload.category, 'bug');
    assert.equal(payload.body, 'webhook success payload check');
    // Sanitized: no PII fields.
    assert.equal('email' in payload, false);
    assert.equal('userId' in payload, false);
    assert.equal('userAgent' in payload, false);
    assert.ok('id' in payload && 'createdAt' in payload);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.FEEDBACK_WEBHOOK_URL;
  }
});
