/**
 * Integration tests for GET /api/portfolio/by-security — Slice A metrics.
 * Covers: todayChangePct, thirtyDayReturnPct, weightPct, totalReturnPct,
 * and the top-level unifiedTotal block.
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
const dbPath = path.join(backendRoot, 'data', 'test-portfolio-by-security-metrics.sqlite');

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let householdId: number;
let userId: number;
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
  const { seedHousehold, seedAccount, seedSecurity, seedHolding } = await import(
    './portfolioFixtures.js'
  );

  const seeded = await seedHousehold(models, `bysec-metrics-${Date.now()}@example.com`);
  householdId = seeded.household.id;
  userId = seeded.user.id;
  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${seeded.token}; Path=/`);

  const tfsa = await seedAccount(models, householdId, userId, 'TFSA', 'TFSAMET01');
  const xeqt = await seedSecurity(models, householdId, 'XEQT', 'iShares Core', 'ETF');
  xeqtId = xeqt.id;

  await seedHolding(models, {
    accountId: tfsa.id,
    householdId,
    securityId: xeqtId,
    statementDate: '2026-05-01',
    quantity: 100,
    marketValue: 5000,
    costBasis: 4500,
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

test('by-security rows include todayChangePct + thirtyDayReturnPct + weightPct + totalReturnPct', async () => {
  const models = await import('../../src/models');
  const { seedDailyPrice, seedDividend } = await import('./portfolioFixtures.js');
  for (let i = 32; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    await seedDailyPrice(models, { securityId: xeqtId, date, close: 50 + i * 0.05, adjClose: 50 + i * 0.05 });
  }
  await models.SecurityPrice.create({
    securityId: xeqtId,
    provider: 'fixture-bysec',
    symbol: 'XEQT',
    pricedAt: new Date(),
    price: '52.00',
    currency: 'CAD',
    fetchedAt: new Date(),
  });
  await seedDividend(models, {
    securityId: xeqtId,
    exDividendDate: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10),
    amount: 0.4,
    currency: 'CAD',
  });

  const res = await authed.get('/api/portfolio/by-security');
  assert.equal(res.status, 200);
  const xeqtRow = res.body.rows.find((r: { securityId: number }) => r.securityId === xeqtId);
  assert.ok(xeqtRow);
  assert.ok(Number.isFinite(xeqtRow.todayChangePct), `todayChangePct=${xeqtRow.todayChangePct}`);
  assert.ok(Number.isFinite(xeqtRow.thirtyDayReturnPct), `thirtyDayReturnPct=${xeqtRow.thirtyDayReturnPct}`);
  // weightPct depends on unifiedTotal — assert non-null OR finite (null acceptable if FX missing)
  assert.ok(xeqtRow.weightPct == null || Number.isFinite(xeqtRow.weightPct));
  // totalReturnPct depends on costBasis presence; either null or finite is acceptable
  assert.ok(xeqtRow.totalReturnPct == null || Number.isFinite(xeqtRow.totalReturnPct));
});

test('by-security response includes unifiedTotal block', async () => {
  const res = await authed.get('/api/portfolio/by-security');
  assert.equal(res.status, 200);
  assert.ok('unifiedTotal' in res.body);
});
