/**
 * Integration tests for /api/tax/entities/:id/spouse POST + DELETE
 * (P10 Task 2 — spouse link API).
 *
 * Mirrors the auth-setup pattern from routes-personal-scenarios.test.ts:
 * - sequelize.sync({ force: true }) instead of running migrations.
 * - Models imported BEFORE sync so all model tables are registered/created.
 * - Direct User + Household + HouseholdMember + Session creation, then
 *   request.agent(app) with cookie injection.
 *
 * Each test creates fresh entities so tests are order-independent — the
 * POST/DELETE handlers mutate spouseEntityId across rows, so sharing fixture
 * entities across tests would couple them.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import crypto from 'crypto';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let householdId: number;

before(async () => {
  process.env.NODE_ENV = 'test';
  const { sequelize } = await import('../db.js');
  // Import models BEFORE sync so all model tables are registered/created.
  const models = await import('../models/index.js');
  await sequelize.sync({ force: true });

  const mod = await import('../app.js');
  app = mod.default;

  const { hashPassword, hashToken } = await import('../auth/password.js');

  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `entities-spouse-${Date.now()}@example.com`,
    displayName: 'Entities Spouse Test',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'Spouse HH' });
  householdId = household.id;
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
  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${token}; Path=/`);
});

after(async () => {
  const { sequelize } = await import('../db.js');
  await sequelize.close();
});

beforeEach(async () => {
  // Wipe entities between tests so spouseEntityId mutations don't leak.
  const models = await import('../models/index.js');
  await models.Entity.destroy({ where: {} });
});

async function createPersonal(legalName: string, hhId: number = householdId) {
  const models = await import('../models/index.js');
  return models.Entity.create({
    householdId: hhId,
    kind: 'personal',
    legalName,
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  });
}

async function createCorp(legalName: string, hhId: number = householdId) {
  const models = await import('../models/index.js');
  return models.Entity.create({
    householdId: hhId,
    kind: 'corp',
    legalName,
    jurisdiction: 'CA-ON',
    fiscalYearEnd: '12-31',
  });
}

test('POST /api/tax/entities/:id/spouse without auth returns 401', async () => {
  const a = await createPersonal('A');
  const b = await createPersonal('B');
  const res = await request(app)
    .post(`/api/tax/entities/${a.id}/spouse`)
    .send({ spouseEntityId: b.id });
  assert.equal(res.status, 401, `expected 401, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('DELETE /api/tax/entities/:id/spouse without auth returns 401', async () => {
  const a = await createPersonal('A');
  const res = await request(app).delete(`/api/tax/entities/${a.id}/spouse`);
  assert.equal(res.status, 401, `expected 401, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('POST happy-path links both directions', async () => {
  const a = await createPersonal('A');
  const b = await createPersonal('B');
  const res = await authed
    .post(`/api/tax/entities/${a.id}/spouse`)
    .send({ spouseEntityId: b.id });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.entity.id, a.id);
  assert.equal(res.body.entity.spouseEntityId, b.id);

  // Verify both directions persisted in DB.
  const models = await import('../models/index.js');
  const reloadedA = await models.Entity.findByPk(a.id);
  const reloadedB = await models.Entity.findByPk(b.id);
  assert.equal(reloadedA?.spouseEntityId, b.id);
  assert.equal(reloadedB?.spouseEntityId, a.id);
});

test('POST idempotent re-link to same spouse returns 200, no-op', async () => {
  const a = await createPersonal('A');
  const b = await createPersonal('B');
  const r1 = await authed
    .post(`/api/tax/entities/${a.id}/spouse`)
    .send({ spouseEntityId: b.id });
  assert.equal(r1.status, 200, `expected 200, got ${r1.status}: ${JSON.stringify(r1.body)}`);

  const r2 = await authed
    .post(`/api/tax/entities/${a.id}/spouse`)
    .send({ spouseEntityId: b.id });
  assert.equal(r2.status, 200, `expected 200 on idempotent re-link, got ${r2.status}: ${JSON.stringify(r2.body)}`);

  const models = await import('../models/index.js');
  const reloadedA = await models.Entity.findByPk(a.id);
  assert.equal(reloadedA?.spouseEntityId, b.id);
});

test('POST returns 409 when entity already linked to a different spouse', async () => {
  const a = await createPersonal('A');
  const b = await createPersonal('B');
  const c = await createPersonal('C');

  // First, link A <-> B.
  const r1 = await authed
    .post(`/api/tax/entities/${a.id}/spouse`)
    .send({ spouseEntityId: b.id });
  assert.equal(r1.status, 200);

  // Now try to link A -> C. A already has B, so conflict.
  const r2 = await authed
    .post(`/api/tax/entities/${a.id}/spouse`)
    .send({ spouseEntityId: c.id });
  assert.equal(r2.status, 409, `expected 409, got ${r2.status}: ${JSON.stringify(r2.body)}`);
  assert.match(r2.body.message ?? '', /already linked/i);
});

test('POST returns 409 when spouse target already linked to a different spouse', async () => {
  const a = await createPersonal('A');
  const b = await createPersonal('B');
  const c = await createPersonal('C');

  // Link B <-> C first.
  const r1 = await authed
    .post(`/api/tax/entities/${b.id}/spouse`)
    .send({ spouseEntityId: c.id });
  assert.equal(r1.status, 200);

  // Now A tries to claim B. B is already taken by C.
  const r2 = await authed
    .post(`/api/tax/entities/${a.id}/spouse`)
    .send({ spouseEntityId: b.id });
  assert.equal(r2.status, 409, `expected 409, got ${r2.status}: ${JSON.stringify(r2.body)}`);
});

test('POST returns 400 when entity is kind=corp', async () => {
  const corp = await createCorp('CorpCo');
  const personal = await createPersonal('P');
  const res = await authed
    .post(`/api/tax/entities/${corp.id}/spouse`)
    .send({ spouseEntityId: personal.id });
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.match(res.body.message ?? '', /personal/i);
});

test('POST returns 400 when spouseEntityId target is kind=corp', async () => {
  const personal = await createPersonal('P');
  const corp = await createCorp('CorpCo');
  const res = await authed
    .post(`/api/tax/entities/${personal.id}/spouse`)
    .send({ spouseEntityId: corp.id });
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.match(res.body.message ?? '', /personal/i);
});

test('POST returns 403 when spouseEntityId belongs to another household', async () => {
  const models = await import('../models/index.js');
  const otherHousehold = await models.Household.create({ name: 'Other HH' });
  const mine = await createPersonal('Mine');
  const theirs = await createPersonal('Theirs', otherHousehold.id);
  const res = await authed
    .post(`/api/tax/entities/${mine.id}/spouse`)
    .send({ spouseEntityId: theirs.id });
  assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('POST returns 403 when :id entity belongs to another household', async () => {
  const models = await import('../models/index.js');
  const otherHousehold = await models.Household.create({ name: 'Other HH' });
  const theirs = await createPersonal('Theirs', otherHousehold.id);
  const mine = await createPersonal('Mine');
  const res = await authed
    .post(`/api/tax/entities/${theirs.id}/spouse`)
    .send({ spouseEntityId: mine.id });
  assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('DELETE happy-path unlinks both sides', async () => {
  const a = await createPersonal('A');
  const b = await createPersonal('B');

  // Link first.
  await authed
    .post(`/api/tax/entities/${a.id}/spouse`)
    .send({ spouseEntityId: b.id });

  // Now unlink.
  const res = await authed.delete(`/api/tax/entities/${a.id}/spouse`);
  assert.equal(res.status, 204, `expected 204, got ${res.status}: ${JSON.stringify(res.body)}`);

  const models = await import('../models/index.js');
  const reloadedA = await models.Entity.findByPk(a.id);
  const reloadedB = await models.Entity.findByPk(b.id);
  assert.equal(reloadedA?.spouseEntityId, null);
  assert.equal(reloadedB?.spouseEntityId, null);
});

test('DELETE is idempotent when no spouse is set (returns 204)', async () => {
  const a = await createPersonal('A');
  const res = await authed.delete(`/api/tax/entities/${a.id}/spouse`);
  assert.equal(res.status, 204, `expected 204, got ${res.status}: ${JSON.stringify(res.body)}`);
});
