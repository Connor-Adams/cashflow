/**
 * Integration tests for GET /api/portfolio/realized. Drives the
 * runAcbForSells path: seed buy + sell activities for one security
 * across two accounts (each with their own ACB) and verify that
 * realized gain matches weighted-average ACB math.
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
const dbPath = path.join(backendRoot, 'data', 'test-portfolio-realized.sqlite');

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let householdId: number;
let userId: number;

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
  const { seedHousehold, seedAccount, seedSecurity, seedActivity } = await import(
    './portfolioFixtures.js'
  );
  const seeded = await seedHousehold(models, `realized-${Date.now()}@example.com`);
  householdId = seeded.household.id;
  userId = seeded.user.id;
  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${seeded.token}; Path=/`);

  const tfsa = await seedAccount(models, householdId, userId, 'TFSA', 'TFSA01');
  const rrsp = await seedAccount(models, householdId, userId, 'RRSP', 'RRSP01');
  const xeqt = await seedSecurity(models, householdId, 'XEQT', 'iShares Core', 'ETF');
  const td = await seedSecurity(models, householdId, 'TD', 'Toronto Dominion', 'EQUITY');

  // TFSA / XEQT: buy 10@$100, buy 10@$140 → avg $120; sell 5@$700 → realized $100.
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

  // RRSP / TD: buy 20@$1000 (avg $50), sell 10@$700 → realized $200.
  await seedActivity(models, {
    accountId: rrsp.id,
    householdId,
    securityId: td.id,
    activityType: 'buy',
    tradeDate: '2024-01-10',
    quantity: 20,
    amount: 1000,
  });
  await seedActivity(models, {
    accountId: rrsp.id,
    householdId,
    securityId: td.id,
    activityType: 'sell',
    tradeDate: '2024-04-10',
    quantity: 10,
    amount: 700,
  });

  // RRSP / XEQT: buy only (no sell — should NOT appear in realized).
  await seedActivity(models, {
    accountId: rrsp.id,
    householdId,
    securityId: xeqt.id,
    activityType: 'buy',
    tradeDate: '2024-05-15',
    quantity: 5,
    amount: 500,
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

test('returns totals, bySecurity, and events arrays', async () => {
  const res = await authed.get('/api/portfolio/realized');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(Array.isArray(res.body.totals));
  assert.ok(Array.isArray(res.body.bySecurity));
  assert.ok(Array.isArray(res.body.events));
});

test('events list contains exactly the two SELLs with correct realized gain', async () => {
  const res = await authed.get('/api/portfolio/realized');
  const events = res.body.events as Array<{
    symbol: string;
    qtySold: number;
    proceeds: number;
    acbAtSale: number;
    realizedGain: number;
    accountName: string;
  }>;
  assert.equal(events.length, 2);
  const xeqtSale = events.find((e) => e.symbol === 'XEQT');
  const tdSale = events.find((e) => e.symbol === 'TD');
  assert.ok(xeqtSale);
  assert.ok(tdSale);
  assert.equal(Math.round(xeqtSale.acbAtSale), 120);
  assert.equal(Math.round(xeqtSale.realizedGain), 100);
  assert.equal(xeqtSale.accountName, 'TFSA');
  assert.equal(Math.round(tdSale.acbAtSale), 50);
  assert.equal(Math.round(tdSale.realizedGain), 200);
  assert.equal(tdSale.accountName, 'RRSP');
});

test('bySecurity aggregates realized gains', async () => {
  const res = await authed.get('/api/portfolio/realized');
  const bySec = res.body.bySecurity as Array<{
    symbol: string;
    realizedGain: number;
    eventCount: number;
  }>;
  const xeqt = bySec.find((r) => r.symbol === 'XEQT');
  const td = bySec.find((r) => r.symbol === 'TD');
  assert.ok(xeqt);
  assert.ok(td);
  assert.equal(Math.round(xeqt.realizedGain), 100);
  assert.equal(xeqt.eventCount, 1);
  assert.equal(Math.round(td.realizedGain), 200);
});

test('totals aggregates per-currency', async () => {
  const res = await authed.get('/api/portfolio/realized');
  const totals = res.body.totals as Array<{
    currency: string;
    realizedGain: number;
    eventCount: number;
  }>;
  assert.equal(totals.length, 1);
  assert.equal(totals[0].currency, 'CAD');
  assert.equal(Math.round(totals[0].realizedGain), 300);
  assert.equal(totals[0].eventCount, 2);
});

test('?dateFrom/?dateTo filters realized events by sale date', async () => {
  // Only the March XEQT sell is in window.
  const res = await authed.get(
    '/api/portfolio/realized?dateFrom=2024-03-01&dateTo=2024-03-31',
  );
  assert.equal(res.status, 200);
  const events = res.body.events as Array<{ symbol: string }>;
  assert.equal(events.length, 1);
  assert.equal(events[0].symbol, 'XEQT');
  const totals = res.body.totals as Array<{ realizedGain: number; eventCount: number }>;
  assert.equal(totals.length, 1);
  assert.equal(Math.round(totals[0].realizedGain), 100);
  assert.equal(totals[0].eventCount, 1);
});

test('Account/security pair with only BUYs does not surface in events', async () => {
  const res = await authed.get('/api/portfolio/realized');
  const events = res.body.events as Array<{ symbol: string; accountName: string }>;
  const rrspXeqt = events.find(
    (e) => e.accountName === 'RRSP' && e.symbol === 'XEQT',
  );
  assert.equal(rrspXeqt, undefined, 'buy-only position must not generate a realized event');
});
