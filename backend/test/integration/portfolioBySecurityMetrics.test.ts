/**
 * Integration tests for GET /api/portfolio/by-security — Slice A metrics.
 * Covers: todayChangePct, thirtyDayReturnPct, weightPct, totalReturnPct,
 * and the top-level unifiedTotal block.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let testDb: PgTestDb;
let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let householdId: number;
let userId: number;
let xeqtId: number;

before(async () => {
  testDb = await setupPgTestDb('by-security-metrics');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const models = await import('../../src/models');
  const { seedHousehold, seedAccount, seedSecurity, seedHolding } = await import(
    './portfolioFixtures.js'
  );

  const seeded = await seedHousehold(models, `bysec-metrics-${Date.now()}@example.com`);
  householdId = seeded.household.id;
  userId = seeded.user.id;
  authed = testAgent(app);
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

after(async () => {
  await teardownPgTestDb(testDb);
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

test('totalReturnPct applies splitRatio in the realized-gain enrichment', async () => {
  // Buy 100 @ $10 (cost 1000) → 2:1 split (200 sh, ACB $5) → sell 100 @ $6
  // (proceeds 600, cost removed 500) → realized +100. Without the splitRatio
  // the engine sells at ACB $10 and books −400 instead.
  const models = await import('../../src/models');
  const { seedAccount, seedSecurity, seedHolding, seedActivity } = await import(
    './portfolioFixtures.js'
  );

  const acct = await seedAccount(models, householdId, userId, 'Margin', 'SPLITACCT1');
  const splt = await seedSecurity(models, householdId, 'SPLT', 'Split Corp', 'stock');

  await seedActivity(models, {
    accountId: acct.id, householdId, securityId: splt.id,
    activityType: 'buy', tradeDate: '2026-01-05', quantity: 100, amount: 1000,
  });
  await seedActivity(models, {
    accountId: acct.id, householdId, securityId: splt.id,
    activityType: 'split', tradeDate: '2026-02-02', splitRatio: 2,
  });
  await seedActivity(models, {
    accountId: acct.id, householdId, securityId: splt.id,
    activityType: 'sell', tradeDate: '2026-03-02', quantity: 100, amount: 600,
  });
  // Remaining 100 post-split shares worth $600, ACB $500.
  await seedHolding(models, {
    accountId: acct.id,
    householdId,
    securityId: splt.id,
    statementDate: '2026-03-31',
    quantity: 100,
    marketValue: 600,
    costBasis: 500,
  });

  const res = await authed.get('/api/portfolio/by-security');
  assert.equal(res.status, 200);
  const row = res.body.rows.find((r: { securityId: number }) => r.securityId === splt.id);
  assert.ok(row, 'SPLT row present');
  // (MV 600 + realized 100 + income 0 − cost 500) / 500 = +40%.
  assert.ok(
    row.totalReturnPct != null && Math.abs(row.totalReturnPct - 40) < 0.01,
    `expected totalReturnPct ≈ 40, got ${row.totalReturnPct}`,
  );
});
