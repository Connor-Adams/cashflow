/**
 * Integration tests for GET /api/portfolio (Holdings) per-row metrics +
 * unifiedTotal delta added in slice A.
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
const dbPath = path.join(backendRoot, 'data', 'test-portfolio-metrics.sqlite');

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let xeqtId: number;
let acctId: number;

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
  const {
    seedHousehold,
    seedAccount,
    seedSecurity,
    seedHolding,
    seedDailyPrice,
    seedDividend,
  } = await import('./portfolioFixtures.js');

  const seeded = await seedHousehold(models, `metrics-${Date.now()}@example.com`);
  const acct = await seedAccount(models, seeded.household.id, seeded.user.id, 'TFSA', 'TFSA01');
  acctId = acct.id;
  const xeqt = await seedSecurity(models, seeded.household.id, 'XEQT', 'iShares', 'ETF');
  xeqtId = xeqt.id;

  // Seed 40 days of daily prices + a SecurityPrice quote + dividends
  for (let i = 40; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    await seedDailyPrice(models, { securityId: xeqt.id, date, close: 30 + i * 0.1, adjClose: 30 + i * 0.1 });
  }
  await models.SecurityPrice.create({
    securityId: xeqt.id,
    provider: 'fixture',
    symbol: 'XEQT',
    pricedAt: new Date(),
    price: '34.00',
    currency: 'CAD',
    fetchedAt: new Date(),
  });
  await seedDividend(models, {
    securityId: xeqt.id,
    exDividendDate: new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10),
    amount: 0.5,
    currency: 'CAD',
  });
  await seedHolding(models, {
    accountId: acct.id, householdId: seeded.household.id, securityId: xeqt.id,
    statementDate: '2026-05-01', quantity: 100, marketValue: 3400, costBasis: 3000,
  });

  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${seeded.token}; Path=/`);
});

after(() => {
  if (fs.existsSync(dbPath)) { try { fs.unlinkSync(dbPath); } catch { /* ignore */ } }
});

test('holdings include todayChangePct + thirtyDayReturnPct + weightPct + yieldOnCostPct', async () => {
  const res = await authed.get('/api/portfolio');
  assert.equal(res.status, 200);
  const xeqt = res.body.holdings.find((h: { securityId: number }) => h.securityId === xeqtId);
  assert.ok(xeqt, 'XEQT holding present');
  assert.ok(Number.isFinite(xeqt.todayChangePct), `todayChangePct=${xeqt.todayChangePct}`);
  assert.ok(Number.isFinite(xeqt.thirtyDayReturnPct), `thirtyDayReturnPct=${xeqt.thirtyDayReturnPct}`);
  assert.ok(Number.isFinite(xeqt.weightPct), `weightPct=${xeqt.weightPct}`);
  assert.ok(Number.isFinite(xeqt.yieldOnCostPct), `yieldOnCostPct=${xeqt.yieldOnCostPct}`);
});

test('unifiedTotal includes todayChangePct + todayChangeCad', async () => {
  const res = await authed.get('/api/portfolio');
  assert.equal(res.status, 200);
  assert.ok(res.body.unifiedTotal, 'unifiedTotal present');
  assert.ok(Number.isFinite(res.body.unifiedTotal.todayChangePct));
  assert.ok(Number.isFinite(res.body.unifiedTotal.todayChangeCad));
});

test('weightPct sums to ~100% across holdings (single security here)', async () => {
  const res = await authed.get('/api/portfolio');
  const total = res.body.holdings.reduce(
    (acc: number, h: { weightPct: number | null }) => acc + (h.weightPct ?? 0),
    0,
  );
  // Single holding → ~100%
  assert.ok(Math.abs(total - 100) < 0.01, `total weight=${total}`);
});
