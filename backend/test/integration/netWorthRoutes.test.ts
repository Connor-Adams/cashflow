import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let testDb: PgTestDb;
let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let otherAuthed: ReturnType<typeof request.agent>;
let myUserId: number;
let myHouseholdId: number;
let otherUserId: number;
let otherHouseholdId: number;

before(async () => {
  testDb = await setupPgTestDb('networth-routes');
  const mod = await import('../../src/app.js');
  app = mod.default;

  const models = await import('../../src/models/index.js');
  const { seedHousehold } = await import('./portfolioFixtures.js');

  const me = await seedHousehold(models, `networth-me-${Date.now()}@example.com`);
  myUserId = me.user.id;
  myHouseholdId = me.household.id;
  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${me.token}; Path=/`);

  const other = await seedHousehold(models, `networth-other-${Date.now()}@example.com`);
  otherUserId = other.user.id;
  otherHouseholdId = other.household.id;
  otherAuthed = request.agent(app);
  otherAuthed.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/net-worth/current: 401 unauthenticated', async () => {
  const res = await request(app).get('/api/net-worth/current');
  assert.equal(res.status, 401);
});

test('GET /api/net-worth/current: returns total derived from CAD accounts', async () => {
  const models = await import('../../src/models/index.js');
  const acc = await models.Account.create({
    name: 'Chq', owner: 'me', accountType: 'checking', defaultCurrency: 'CAD',
    openingBalance: '1000', householdId: myHouseholdId, ownerUserId: myUserId,
  } as never);
  const fp = `t-${Date.now()}`;
  await models.Transaction.create({
    accountId: acc.id, date: '2026-01-01', amount: '-100', currency: 'CAD',
    merchantRaw: 't', merchantClean: 't', importBatch: 'test',
    householdId: myHouseholdId,
    sourceRowFingerprint: fp, sourceIdentityFingerprint: fp,
  } as never);

  const res = await authed.get('/api/net-worth/current').query({ asOf: '2026-02-01' });
  assert.equal(res.status, 200, `body=${res.text}`);
  assert.equal(res.body.total, 900);
  assert.equal(res.body.baseCurrency, 'CAD');
});

test('GET /api/net-worth/current: rejects asOf in future', async () => {
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const res = await authed.get('/api/net-worth/current').query({ asOf: tomorrow });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /future/);
});

test('GET /api/net-worth/series: rejects daily > 90 days', async () => {
  const res = await authed.get('/api/net-worth/series').query({
    from: '2025-01-01', to: '2026-01-01', granularity: 'daily',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /90/);
});

test('GET /api/net-worth/series: rejects monthly > 240 buckets', async () => {
  const res = await authed.get('/api/net-worth/series').query({
    from: '2000-01-01', to: '2026-01-01', granularity: 'monthly',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /240/);
});

test('GET /api/net-worth/series: returns monthly bucket points', async () => {
  const res = await authed.get('/api/net-worth/series').query({
    from: '2026-01-01', to: '2026-03-31', granularity: 'monthly',
  });
  assert.equal(res.status, 200, `body=${res.text}`);
  const dates = (res.body.points as Array<{ date: string }>).map((p) => p.date);
  assert.deepEqual(dates, ['2026-01-31', '2026-02-28', '2026-03-31']);
});

test('PATCH /api/net-worth/accounts/:id/opening-balance: updates fields', async () => {
  const models = await import('../../src/models/index.js');
  const acc = await models.Account.create({
    name: 'Chq2', owner: 'me', accountType: 'checking', defaultCurrency: 'CAD',
    householdId: myHouseholdId, ownerUserId: myUserId,
  } as never);
  const res = await authed.patch(`/api/net-worth/accounts/${acc.id}/opening-balance`).send({
    openingBalance: 2500, openingBalanceDate: '2025-12-31',
  });
  assert.equal(res.status, 200, `body=${res.text}`);
  await acc.reload();
  assert.equal(Number(acc.openingBalance), 2500);
  assert.equal(acc.openingBalanceDate, '2025-12-31');
});

test('PATCH /api/net-worth/accounts/:id/opening-balance: 403 for other-user account', async () => {
  const models = await import('../../src/models/index.js');
  const otherAcc = await models.Account.create({
    name: 'OtherAcc', owner: 'me', accountType: 'checking', defaultCurrency: 'CAD',
    householdId: otherHouseholdId, ownerUserId: otherUserId,
  } as never);
  const res = await authed.patch(`/api/net-worth/accounts/${otherAcc.id}/opening-balance`).send({
    openingBalance: 1, openingBalanceDate: null,
  });
  assert.equal(res.status, 403);
});
