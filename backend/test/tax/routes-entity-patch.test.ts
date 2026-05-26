/**
 * Integration tests for PATCH /api/tax/entities/:id
 * (P11b Task 7 — associated-group picker backend).
 *
 * Mirrors the auth-setup pattern from routes-entities-spouse.test.ts:
 * - sequelize.sync({ force: true }) instead of running migrations.
 * - Models imported BEFORE sync so all model tables are registered/created.
 * - Direct User + Household + HouseholdMember + Session creation, then
 *   request.agent(app) with cookie injection.
 *
 * Each test creates fresh entities so tests are order-independent.
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
  const { sequelize } = await import('../../src/db.js');
  const models = await import('../../src/models/index.js');
  await sequelize.sync({ force: true });

  const mod = await import('../../src/app.js');
  app = mod.default;

  const { hashPassword, hashToken } = await import('../../src/auth/password.js');

  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `entity-patch-${Date.now()}@example.com`,
    displayName: 'Entity PATCH Test',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'PATCH HH' });
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
  const { sequelize } = await import('../../src/db.js');
  await sequelize.close();
});

beforeEach(async () => {
  const models = await import('../../src/models/index.js');
  await models.Entity.destroy({ where: {} });
});

async function createPersonal(legalName: string, hhId: number = householdId) {
  const models = await import('../../src/models/index.js');
  return models.Entity.create({
    householdId: hhId,
    kind: 'personal',
    legalName,
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  });
}

async function createCorp(legalName: string, hhId: number = householdId) {
  const models = await import('../../src/models/index.js');
  return models.Entity.create({
    householdId: hhId,
    kind: 'corp',
    legalName,
    jurisdiction: 'CA-ON',
    fiscalYearEnd: '12-31',
  });
}

test('PATCH /api/tax/entities/:id without auth returns 401', async () => {
  const corp = await createCorp('Opco');
  const res = await request(app)
    .patch(`/api/tax/entities/${corp.id}`)
    .send({ associatedGroupId: 'ABCorp' });
  assert.equal(res.status, 401, `expected 401, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('PATCH happy-path sets associatedGroupId on a corp', async () => {
  const corp = await createCorp('Opco');
  const res = await authed
    .patch(`/api/tax/entities/${corp.id}`)
    .send({ associatedGroupId: 'ABCorp' });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.entity.id, corp.id);
  assert.equal(res.body.entity.associatedGroupId, 'ABCorp');

  const models = await import('../../src/models/index.js');
  const reloaded = await models.Entity.findByPk(corp.id);
  assert.equal(reloaded?.associatedGroupId, 'ABCorp');
});

test('PATCH with null clears associatedGroupId', async () => {
  const corp = await createCorp('Opco');
  // First set a value.
  await authed
    .patch(`/api/tax/entities/${corp.id}`)
    .send({ associatedGroupId: 'ABCorp' });
  // Then clear it.
  const res = await authed
    .patch(`/api/tax/entities/${corp.id}`)
    .send({ associatedGroupId: null });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.entity.associatedGroupId, null);

  const models = await import('../../src/models/index.js');
  const reloaded = await models.Entity.findByPk(corp.id);
  assert.equal(reloaded?.associatedGroupId, null);
});

test('PATCH with empty string clears associatedGroupId', async () => {
  // UX convenience: blanking the text input shouldn't require a separate gesture.
  const corp = await createCorp('Opco');
  await authed
    .patch(`/api/tax/entities/${corp.id}`)
    .send({ associatedGroupId: 'ABCorp' });
  const res = await authed
    .patch(`/api/tax/entities/${corp.id}`)
    .send({ associatedGroupId: '   ' });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.entity.associatedGroupId, null);
});

test('PATCH returns 400 when entity is kind=personal', async () => {
  const personal = await createPersonal('P');
  const res = await authed
    .patch(`/api/tax/entities/${personal.id}`)
    .send({ associatedGroupId: 'ABCorp' });
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.match(res.body.message ?? '', /corp/i);
});

test('PATCH returns 403 when entity belongs to another household', async () => {
  const models = await import('../../src/models/index.js');
  const otherHousehold = await models.Household.create({ name: 'Other HH' });
  const theirs = await createCorp('TheirCorp', otherHousehold.id);
  const res = await authed
    .patch(`/api/tax/entities/${theirs.id}`)
    .send({ associatedGroupId: 'ABCorp' });
  assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('PATCH returns 404 when entity does not exist', async () => {
  const res = await authed
    .patch(`/api/tax/entities/9999999`)
    .send({ associatedGroupId: 'ABCorp' });
  assert.equal(res.status, 404, `expected 404, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('PATCH returns 400 when body missing associatedGroupId', async () => {
  const corp = await createCorp('Opco');
  const res = await authed
    .patch(`/api/tax/entities/${corp.id}`)
    .send({});
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('PATCH returns 400 when associatedGroupId is not a string or null', async () => {
  const corp = await createCorp('Opco');
  const res = await authed
    .patch(`/api/tax/entities/${corp.id}`)
    .send({ associatedGroupId: 42 });
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
});
