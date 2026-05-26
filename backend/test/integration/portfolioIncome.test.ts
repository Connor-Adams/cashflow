/**
 * Integration tests for GET /api/portfolio/income. Seeds dividend +
 * interest activities across two accounts and three months, then
 * verifies grouping by month, security, account, and totals — plus
 * the optional ?dateFrom / ?dateTo filter.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let testDb: PgTestDb;
let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let householdId: number;
let userId: number;

before(async () => {
  testDb = await setupPgTestDb('income');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const models = await import('../../src/models');
  const { seedHousehold, seedAccount, seedSecurity, seedActivity } = await import(
    './portfolioFixtures.js'
  );
  const seeded = await seedHousehold(models, `income-${Date.now()}@example.com`);
  householdId = seeded.household.id;
  userId = seeded.user.id;
  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${seeded.token}; Path=/`);

  const tfsa = await seedAccount(models, householdId, userId, 'TFSA', 'TFSA01');
  const rrsp = await seedAccount(models, householdId, userId, 'RRSP', 'RRSP01');
  const xeqt = await seedSecurity(models, householdId, 'XEQT', 'iShares Core', 'ETF');
  const cm = await seedSecurity(models, householdId, 'CM', 'CIBC', 'EQUITY');

  // TFSA: Jan dividend $30 (XEQT), Feb dividend $35 (XEQT), Mar interest $5
  await seedActivity(models, {
    accountId: tfsa.id,
    householdId,
    securityId: xeqt.id,
    activityType: 'dividend',
    tradeDate: '2025-01-15',
    amount: 30,
  });
  await seedActivity(models, {
    accountId: tfsa.id,
    householdId,
    securityId: xeqt.id,
    activityType: 'dividend',
    tradeDate: '2025-02-15',
    amount: 35,
  });
  await seedActivity(models, {
    accountId: tfsa.id,
    householdId,
    securityId: null,
    activityType: 'interest',
    tradeDate: '2025-03-31',
    amount: 5,
  });
  // RRSP: Feb dividend $50 (CM), Mar dividend $55 (CM)
  await seedActivity(models, {
    accountId: rrsp.id,
    householdId,
    securityId: cm.id,
    activityType: 'dividend',
    tradeDate: '2025-02-20',
    amount: 50,
  });
  await seedActivity(models, {
    accountId: rrsp.id,
    householdId,
    securityId: cm.id,
    activityType: 'dividend',
    tradeDate: '2025-03-20',
    amount: 55,
  });
  // Non-income activity (BUY) — must NOT show up.
  await seedActivity(models, {
    accountId: tfsa.id,
    householdId,
    securityId: xeqt.id,
    activityType: 'buy',
    tradeDate: '2025-01-05',
    quantity: 10,
    amount: 500,
  });
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('returns byMonth, bySecurity, byAccount, and totals', async () => {
  const res = await authed.get('/api/portfolio/income');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(Array.isArray(res.body.byMonth));
  assert.ok(Array.isArray(res.body.bySecurity));
  assert.ok(Array.isArray(res.body.byAccount));
  assert.ok(Array.isArray(res.body.totals));
});

test('byMonth aggregates dividend + interest per YYYY-MM', async () => {
  const res = await authed.get('/api/portfolio/income');
  const byMonth = res.body.byMonth as Array<{
    month: string;
    dividend: number;
    interest: number;
    total: number;
  }>;
  // Three months, all CAD: 2025-01 (30 div), 2025-02 (35+50=85 div), 2025-03 (55 div + 5 int = 60).
  const jan = byMonth.find((r) => r.month === '2025-01');
  const feb = byMonth.find((r) => r.month === '2025-02');
  const mar = byMonth.find((r) => r.month === '2025-03');
  assert.ok(jan);
  assert.ok(feb);
  assert.ok(mar);
  assert.equal(Math.round(jan.dividend), 30);
  assert.equal(Math.round(jan.interest), 0);
  assert.equal(Math.round(feb.dividend), 85);
  assert.equal(Math.round(mar.dividend), 55);
  assert.equal(Math.round(mar.interest), 5);
  assert.equal(Math.round(mar.total), 60);
});

test('BUY activities are excluded from income', async () => {
  const res = await authed.get('/api/portfolio/income');
  const total = res.body.totals.find(
    (r: { currency: string }) => r.currency === 'CAD',
  );
  // 30 + 35 + 5 + 50 + 55 = 175 — no BUY amount 500 anywhere.
  assert.ok(total);
  assert.equal(Math.round(total.total), 175);
});

test('bySecurity groups dividend totals per security', async () => {
  const res = await authed.get('/api/portfolio/income');
  const bySec = res.body.bySecurity as Array<{
    symbol: string | null;
    dividend: number;
    interest: number;
    activityCount: number;
  }>;
  const xeqt = bySec.find((r) => r.symbol === 'XEQT');
  const cm = bySec.find((r) => r.symbol === 'CM');
  const nullSym = bySec.find((r) => r.symbol === null);
  assert.ok(xeqt);
  assert.ok(cm);
  assert.ok(nullSym, 'interest with null security should bucket separately');
  assert.equal(Math.round(xeqt.dividend), 65);
  assert.equal(Math.round(cm.dividend), 105);
  assert.equal(Math.round(nullSym.interest), 5);
});

test('byAccount groups per account', async () => {
  const res = await authed.get('/api/portfolio/income');
  const byAcc = res.body.byAccount as Array<{
    accountName: string;
    total: number;
  }>;
  const tfsa = byAcc.find((r) => r.accountName === 'TFSA');
  const rrsp = byAcc.find((r) => r.accountName === 'RRSP');
  assert.ok(tfsa);
  assert.ok(rrsp);
  assert.equal(Math.round(tfsa.total), 70); // 30+35+5
  assert.equal(Math.round(rrsp.total), 105); // 50+55
});

test('?dateFrom/?dateTo filters tradeDate inclusively', async () => {
  const res = await authed.get(
    '/api/portfolio/income?dateFrom=2025-02-01&dateTo=2025-02-28',
  );
  assert.equal(res.status, 200);
  const total = res.body.totals.find(
    (r: { currency: string }) => r.currency === 'CAD',
  );
  // Only Feb in window: 35 + 50 = 85.
  assert.ok(total);
  assert.equal(Math.round(total.total), 85);
});

test('Malformed dateFrom is ignored (no error, returns full dataset)', async () => {
  const res = await authed.get('/api/portfolio/income?dateFrom=not-a-date');
  assert.equal(res.status, 200);
  const total = res.body.totals.find(
    (r: { currency: string }) => r.currency === 'CAD',
  );
  assert.equal(Math.round(total.total), 175);
});
