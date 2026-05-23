/**
 * Integration tests for GET /api/portfolio/security/:id (per-security
 * drill). Seeds holdings + activities for one security across two
 * accounts and verifies the combined + per-account stats, the ACB
 * timeline, and the full activity list.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import request from 'supertest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-portfolio-security-drill.sqlite');

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let householdId: number;
let userId: number;
let xeqtId: number;
let tdId: number; // a security with no holdings under this user

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';

  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'development' },
    stdio: 'pipe',
  });

  const mod = await import('../../src/app.js');
  app = mod.default;

  const models = await import('../../src/models');
  const { seedHousehold, seedAccount, seedSecurity, seedHolding, seedActivity } =
    await import('./portfolioFixtures.js');
  const seeded = await seedHousehold(models, `drill-${Date.now()}@example.com`);
  householdId = seeded.household.id;
  userId = seeded.user.id;
  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${seeded.token}; Path=/`);

  const tfsa = await seedAccount(models, householdId, userId, 'TFSA', 'TFSA01');
  const rrsp = await seedAccount(models, householdId, userId, 'RRSP', 'RRSP01');
  const xeqt = await seedSecurity(models, householdId, 'XEQT', 'iShares Core', 'ETF');
  const td = await seedSecurity(models, householdId, 'TD', 'Toronto Dominion', 'EQUITY');
  xeqtId = xeqt.id;
  tdId = td.id;

  // TFSA / XEQT: buy 10@$100, buy 10@$140 (avg 120), sell 5@$700 (realized 100).
  await seedActivity(models, {
    accountId: tfsa.id,
    householdId,
    securityId: xeqt.id,
    activityType: 'buy',
    tradeDate: '2024-01-15',
    quantity: 10,
    amount: 1000,
  });
  await seedActivity(models, {
    accountId: tfsa.id,
    householdId,
    securityId: xeqt.id,
    activityType: 'buy',
    tradeDate: '2024-02-15',
    quantity: 10,
    amount: 1400,
  });
  await seedActivity(models, {
    accountId: tfsa.id,
    householdId,
    securityId: xeqt.id,
    activityType: 'sell',
    tradeDate: '2024-03-15',
    quantity: 5,
    amount: 700,
  });
  // TFSA / XEQT dividend $25
  await seedActivity(models, {
    accountId: tfsa.id,
    householdId,
    securityId: xeqt.id,
    activityType: 'dividend',
    tradeDate: '2024-04-15',
    amount: 25,
  });

  // RRSP / XEQT: buy only 5@$500 = avg $100.
  await seedActivity(models, {
    accountId: rrsp.id,
    householdId,
    securityId: xeqt.id,
    activityType: 'buy',
    tradeDate: '2024-05-15',
    quantity: 5,
    amount: 500,
  });

  // Holdings: TFSA 15 @ 6000 MV cost 1800 (preserved per-unit 120 * 15 = 1800 broker cost).
  await seedHolding(models, {
    accountId: tfsa.id,
    householdId,
    securityId: xeqt.id,
    statementDate: '2026-05-01',
    quantity: 15,
    marketValue: 6000,
    costBasis: 1800,
  });
  // RRSP 5 @ 600 MV cost 500.
  await seedHolding(models, {
    accountId: rrsp.id,
    householdId,
    securityId: xeqt.id,
    statementDate: '2026-05-01',
    quantity: 5,
    marketValue: 600,
    costBasis: 500,
  });
});

after(() => {
  if (fs.existsSync(dbPath)) {
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  }
});

test('returns security header, perAccount, combined, activities, holdings', async () => {
  const res = await authed.get(`/api/portfolio/security/${xeqtId}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.security.symbol, 'XEQT');
  assert.equal(res.body.security.id, xeqtId);
  assert.ok(Array.isArray(res.body.perAccount));
  assert.ok(res.body.combined);
  assert.ok(Array.isArray(res.body.activities));
  assert.ok(Array.isArray(res.body.holdings));
});

test('combined stats roll up across both accounts', async () => {
  const res = await authed.get(`/api/portfolio/security/${xeqtId}`);
  const c = res.body.combined as {
    currentQuantity: number;
    currentMarketValue: number;
    currentCostBasis: number;
    realizedTotal: number;
    income: { dividend: number; interest: number };
  };
  assert.equal(Math.round(c.currentQuantity), 20); // 15 + 5
  assert.equal(Math.round(c.currentMarketValue), 6600); // 6000 + 600
  assert.equal(Math.round(c.currentCostBasis), 2300); // 1800 + 500
  assert.equal(Math.round(c.realizedTotal), 100); // only TFSA SELL
  assert.equal(Math.round(c.income.dividend), 25);
  assert.equal(Math.round(c.income.interest), 0);
});

test('perAccount yields one entry per involved account with ACB results', async () => {
  const res = await authed.get(`/api/portfolio/security/${xeqtId}`);
  const perAccount = res.body.perAccount as Array<{
    accountName: string;
    currentQuantity: number;
    acb: {
      finalState: { quantity: number; acbPerUnit: number };
      realizedTotal: number;
      timeline: Array<{ asOf: string }>;
    };
  }>;
  assert.equal(perAccount.length, 2);
  const tfsa = perAccount.find((p) => p.accountName === 'TFSA');
  const rrsp = perAccount.find((p) => p.accountName === 'RRSP');
  assert.ok(tfsa);
  assert.ok(rrsp);
  // TFSA ACB: 15 units left, preserved 120/unit after the partial sell, realized 100.
  assert.equal(Math.round(tfsa.acb.finalState.quantity), 15);
  assert.equal(Math.round(tfsa.acb.finalState.acbPerUnit), 120);
  assert.equal(Math.round(tfsa.acb.realizedTotal), 100);
  // RRSP: only a BUY, ACB 100/unit, realized 0.
  assert.equal(Math.round(rrsp.acb.finalState.quantity), 5);
  assert.equal(Math.round(rrsp.acb.finalState.acbPerUnit), 100);
  assert.equal(Math.round(rrsp.acb.realizedTotal), 0);
  // Timeline: 3 events for TFSA, 1 for RRSP.
  assert.equal(tfsa.acb.timeline.length, 3);
  assert.equal(rrsp.acb.timeline.length, 1);
});

test('activities list contains all rows, including dividend', async () => {
  const res = await authed.get(`/api/portfolio/security/${xeqtId}`);
  const activities = res.body.activities as Array<{ activityType: string }>;
  // 3 buys + 1 sell + 1 dividend = 5 total (TFSA 4 + RRSP 1)
  assert.equal(activities.length, 5);
  const buys = activities.filter((a) => a.activityType === 'buy').length;
  const sells = activities.filter((a) => a.activityType === 'sell').length;
  const divs = activities.filter((a) => a.activityType === 'dividend').length;
  assert.equal(buys, 3);
  assert.equal(sells, 1);
  assert.equal(divs, 1);
});

test('holdings list includes both account snapshots', async () => {
  const res = await authed.get(`/api/portfolio/security/${xeqtId}`);
  const holdings = res.body.holdings as Array<{ accountName: string }>;
  assert.equal(holdings.length, 2);
  const names = holdings.map((h) => h.accountName).sort();
  assert.deepEqual(names, ['RRSP', 'TFSA']);
});

test('Invalid security id returns 400', async () => {
  const res = await authed.get('/api/portfolio/security/not-a-number');
  assert.equal(res.status, 400);
});

test('Security with no holdings or activities for this user returns 404', async () => {
  // tdId exists as a Security row, but has no holdings or activities seeded.
  const res = await authed.get(`/api/portfolio/security/${tdId}`);
  assert.equal(res.status, 404);
});

test('Unknown security id returns 404', async () => {
  const res = await authed.get('/api/portfolio/security/9999999');
  assert.equal(res.status, 404);
});
