/**
 * Integration tests for GET /api/portfolio/sparklines.
 *
 * Verifies: household scoping, security inclusion rule
 * (must have activity or holding), 30-day window, omission
 * of securities without daily-price rows, range param validation.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let xeqtId: number;
let bnsId: number;
let untradedId: number;
let testDb: PgTestDb;

before(async () => {
  process.env.NODE_ENV = 'test';
  testDb = await setupPgTestDb('portfolio-sparklines');

  const mod = await import('../../src/app.js');
  app = mod.default;
  const models = await import('../../src/models');
  const {
    seedHousehold,
    seedAccount,
    seedSecurity,
    seedHolding,
    seedDailyPrice,
  } = await import('./portfolioFixtures.js');

  const seeded = await seedHousehold(models, `spark-${Date.now()}@example.com`);
  const acct = await seedAccount(models, seeded.household.id, seeded.user.id, 'TFSA', 'TFSA01');

  const xeqt = await seedSecurity(models, seeded.household.id, 'XEQT', 'iShares', 'ETF');
  const bns = await seedSecurity(models, seeded.household.id, 'BNS', 'Scotiabank', 'EQUITY');
  const untraded = await seedSecurity(models, seeded.household.id, 'NONE', 'Untraded', 'EQUITY');
  xeqtId = xeqt.id;
  bnsId = bns.id;
  untradedId = untraded.id;

  // XEQT — full 35 days of daily prices, held in account
  for (let i = 35; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    await seedDailyPrice(models, { securityId: xeqt.id, date, close: 30 + i * 0.05 });
  }
  await seedHolding(models, {
    accountId: acct.id, householdId: seeded.household.id, securityId: xeqt.id,
    statementDate: '2026-05-01', quantity: 100, marketValue: 3000, costBasis: 2700,
  });

  // BNS — only 5 days of daily prices, held in account
  for (let i = 5; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    await seedDailyPrice(models, { securityId: bns.id, date, close: 70 + i * 0.1 });
  }
  await seedHolding(models, {
    accountId: acct.id, householdId: seeded.household.id, securityId: bns.id,
    statementDate: '2026-05-01', quantity: 20, marketValue: 1400, costBasis: 1300,
  });

  // untraded — has daily prices but no holding or activity in caller's accounts;
  // must be EXCLUDED from response.
  await seedDailyPrice(models, { securityId: untraded.id, date: '2026-05-20', close: 5 });
  await seedDailyPrice(models, { securityId: untraded.id, date: '2026-05-21', close: 5.1 });

  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${seeded.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('returns 30-day sparklines for visible held securities', async () => {
  const res = await authed.get('/api/portfolio/sparklines?range=30d');
  assert.equal(res.status, 200);
  assert.equal(res.body.range, '30d');
  const xeqtSeries = res.body.bySecurityId[String(xeqtId)] as Array<{ date: string; close: number }>;
  assert.ok(Array.isArray(xeqtSeries), 'XEQT series should be present');
  assert.ok(xeqtSeries.length >= 28 && xeqtSeries.length <= 31, `XEQT count=${xeqtSeries.length}`);
  for (let i = 1; i < xeqtSeries.length; i++) {
    assert.ok(xeqtSeries[i - 1].date <= xeqtSeries[i].date);
  }
  assert.equal(typeof xeqtSeries[0].close, 'number');
});

test('returns fewer points when fewer days exist', async () => {
  const res = await authed.get('/api/portfolio/sparklines?range=30d');
  const bnsSeries = res.body.bySecurityId[String(bnsId)] as Array<{ date: string; close: number }>;
  assert.ok(Array.isArray(bnsSeries));
  assert.ok(bnsSeries.length >= 5 && bnsSeries.length <= 6, `BNS count=${bnsSeries.length}`);
});

test('omits securities the caller does not hold (no activity, no holding)', async () => {
  const res = await authed.get('/api/portfolio/sparklines?range=30d');
  assert.equal(res.body.bySecurityId[String(untradedId)], undefined);
});

test('omits held securities that have no daily-price rows', async () => {
  const models = await import('../../src/models');
  const { seedAccount, seedSecurity, seedHolding, seedHousehold } = await import('./portfolioFixtures.js');
  const second = await seedHousehold(models, `spark-empty-${Date.now()}@example.com`);
  const acct2 = await seedAccount(models, second.household.id, second.user.id, 'TFSA', 'TFSA02');
  const sec = await seedSecurity(models, second.household.id, 'EMPTY', 'No prices', 'EQUITY');
  await seedHolding(models, {
    accountId: acct2.id, householdId: second.household.id, securityId: sec.id,
    statementDate: '2026-05-01', quantity: 1, marketValue: 1, costBasis: 1,
  });
  const agent2 = request.agent(app);
  agent2.jar.setCookie(`cashflow_session=${second.token}; Path=/`);
  const res = await agent2.get('/api/portfolio/sparklines?range=30d');
  assert.equal(res.status, 200);
  assert.equal(res.body.bySecurityId[String(sec.id)], undefined);
});

test('invalid range param returns 400', async () => {
  const res = await authed.get('/api/portfolio/sparklines?range=7d');
  assert.equal(res.status, 400);
});

test('default range (no param) returns 30d', async () => {
  const res = await authed.get('/api/portfolio/sparklines');
  assert.equal(res.status, 200);
  assert.equal(res.body.range, '30d');
});
