/**
 * Integration tests for GET /api/portfolio/security/:id/prices.
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
const dbPath = path.join(backendRoot, 'data', 'test-portfolio-prices.sqlite');

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let xeqtId: number;

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
  const { seedHousehold, seedAccount, seedSecurity, seedDailyPrice } = await import(
    './portfolioFixtures.js'
  );
  const seeded = await seedHousehold(models, `prices-${Date.now()}@example.com`);
  const acct = await seedAccount(models, seeded.household.id, seeded.user.id, 'TFSA', 'TFSA01');
  const xeqt = await seedSecurity(models, seeded.household.id, 'XEQT', 'iShares', 'ETF');
  xeqtId = xeqt.id;

  // Seed 400 days of close history (1Y range = 365 days)
  for (let i = 400; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    await seedDailyPrice(models, { securityId: xeqt.id, date, close: 30 + i * 0.01, adjClose: 30 + i * 0.01 });
  }
  // Seed a buy and a sell to verify trades overlay
  await models.InvestmentActivity.create({
    accountId: acct.id, householdId: seeded.household.id, securityId: xeqt.id,
    activityType: 'buy', tradeDate: new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 10),
    description: 'Bought XEQT', quantity: '10', price: '30', amount: '300', currency: 'CAD',
    sourceRowFingerprint: 'fp-buy', importBatch: 'fixture',
  });

  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${seeded.token}; Path=/`);
});

after(() => {
  if (fs.existsSync(dbPath)) { try { fs.unlinkSync(dbPath); } catch { /* ignore */ } }
});

test('range=1y returns ~365 rows and includes trades within range', async () => {
  const res = await authed.get(`/api/portfolio/security/${xeqtId}/prices?range=1y`);
  assert.equal(res.status, 200);
  assert.ok(res.body.rows.length >= 360 && res.body.rows.length <= 366, `rows=${res.body.rows.length}`);
  assert.equal(res.body.range, '1y');
  assert.ok(res.body.trades.length >= 1, 'buy should appear');
  assert.equal(res.body.backfill.status, 'fresh');
});

test('range=1m returns ~30 rows', async () => {
  const res = await authed.get(`/api/portfolio/security/${xeqtId}/prices?range=1m`);
  assert.equal(res.status, 200);
  assert.ok(res.body.rows.length >= 28 && res.body.rows.length <= 32, `rows=${res.body.rows.length}`);
});

test('range=all returns full history', async () => {
  const res = await authed.get(`/api/portfolio/security/${xeqtId}/prices?range=all`);
  assert.equal(res.status, 200);
  assert.equal(res.body.rows.length, 401);
});

test('404 for security id not in this household', async () => {
  const res = await authed.get('/api/portfolio/security/99999/prices');
  assert.equal(res.status, 404);
});
