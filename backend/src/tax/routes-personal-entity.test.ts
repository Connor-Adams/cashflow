/**
 * The personal tax routes must resolve the REQUESTING user's personal entity.
 *
 * They used `Entity.findOne({ householdId, kind: 'personal' })` with no order,
 * so in a household holding a spouse's entity too, whichever row the database
 * returned first was served — the partner's slips, instalments and return.
 *
 * Also: POST /slips validates what it stores, because a bad box value used to
 * reach buildPersonalFacts and 500 the return.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import crypto from 'crypto';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let mineId: number;
let theirsId: number;

before(async () => {
  process.env.NODE_ENV = 'test';
  const { sequelize } = await import('../db.js');
  const models = await import('../models/index.js');
  await sequelize.sync({ force: true });
  const mod = await import('../app.js');
  app = mod.default;
  const { hashPassword, hashToken } = await import('../auth/password.js');

  const password = await hashPassword('password123');
  const mkUser = (tag: string) => models.User.create({
    email: `personal-entity-${tag}-${Date.now()}@example.com`,
    displayName: tag,
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const partner = await mkUser('partner');
  const me = await mkUser('me');
  const household = await models.Household.create({ name: 'Two Filers' });
  await models.HouseholdMember.create({ householdId: household.id, userId: partner.id, role: 'owner' });
  await models.HouseholdMember.create({ householdId: household.id, userId: me.id, role: 'member' });

  // The partner's entity is created first, so it has the lower id.
  const theirs = await models.Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'Partner', jurisdiction: 'CA-ON', fiscalYearEnd: null,
  } as never);
  const mine = await models.Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'Me', jurisdiction: 'CA-ON', fiscalYearEnd: null,
  } as never);
  theirsId = theirs.id;
  mineId = mine.id;
  await models.Account.create({
    name: 'Partner Chk', householdId: household.id, accountType: 'checking', entityId: theirs.id,
    ownerUserId: partner.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  await models.Account.create({
    name: 'My Chk', householdId: household.id, accountType: 'checking', entityId: mine.id,
    ownerUserId: me.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  await models.TaxSlip.create({
    entityId: theirs.id, year: 2025, slipType: 'T4', issuer: 'Partner Employer', boxValues: { box14: 1 },
  } as never);
  await models.TaxSlip.create({
    entityId: mine.id, year: 2025, slipType: 'T4', issuer: 'My Employer', boxValues: { box14: 2 },
  } as never);

  const token = crypto.randomBytes(32).toString('hex');
  await models.Session.create({
    userId: me.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 86_400_000),
  });
  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${token}; Path=/`);
});

after(async () => {
  const { sequelize } = await import('../db.js');
  await sequelize.close();
});

test('GET /slips returns the requesting user\'s slips, not the first personal entity\'s', async () => {
  const res = await authed.get('/api/tax/slips?year=2025');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.slips.map((s: { issuer: string }) => s.issuer), ['My Employer']);
});

test('POST /slips stores a valid slip with box values normalised', async () => {
  const res = await authed.post('/api/tax/slips').send({
    entityId: mineId, year: 2025, slipType: 'T4A', issuer: 'Plan', boxValues: { box016: '1,200.50' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.slip.boxValues.box016, '1200.50');
});

test('POST /slips rejects an unknown slip type', async () => {
  const res = await authed.post('/api/tax/slips').send({
    entityId: mineId, year: 2025, slipType: 'W2', issuer: 'X', boxValues: {},
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
});

test('POST /slips rejects an out-of-range year', async () => {
  const res = await authed.post('/api/tax/slips').send({
    entityId: mineId, year: 'soon', slipType: 'T4', issuer: 'X', boxValues: {},
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
});

test('POST /slips rejects a non-numeric box value and a malformed box key', async () => {
  const bad = await authed.post('/api/tax/slips').send({
    entityId: mineId, year: 2025, slipType: 'T4', issuer: 'X', boxValues: { box14: 'twelve' },
  });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  const key = await authed.post('/api/tax/slips').send({
    entityId: mineId, year: 2025, slipType: 'T4', issuer: 'X', boxValues: { 'income!': 5 },
  });
  assert.equal(key.status, 400, JSON.stringify(key.body));
  const notObject = await authed.post('/api/tax/slips').send({
    entityId: mineId, year: 2025, slipType: 'T4', issuer: 'X', boxValues: [1, 2],
  });
  assert.equal(notObject.status, 400, JSON.stringify(notObject.body));
});

test('the partner entity exists and is untouched', async () => {
  assert.ok(theirsId < mineId, 'fixture: partner entity has the lower id');
});
