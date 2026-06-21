/**
 * Integration tests for GET /api/portfolio/by-security. Verifies the
 * cross-account aggregate: total quantity / cost / market value, the
 * null-propagation behavior for cost basis when one breakdown row is
 * missing it, and the per-account breakdown.
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

before(async () => {
  testDb = await setupPgTestDb('by-security');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const models = await import('../../src/models');
  const { seedHousehold, seedAccount, seedSecurity, seedHolding } = await import(
    './portfolioFixtures.js'
  );
  const seeded = await seedHousehold(models, `bysec-${Date.now()}@example.com`);
  householdId = seeded.household.id;
  userId = seeded.user.id;
  authed = testAgent(app);
  authed.jar.setCookie(`cashflow_session=${seeded.token}; Path=/`);

  const tfsa = await seedAccount(models, householdId, userId, 'TFSA', 'TFSA01');
  const rrsp = await seedAccount(models, householdId, userId, 'RRSP', 'RRSP01');
  const xeqt = await seedSecurity(models, householdId, 'XEQT', 'iShares Core', 'ETF');
  const td = await seedSecurity(models, householdId, 'TD', 'Toronto Dominion', 'EQUITY');

  // XEQT held in both accounts. Cost basis MISSING from RRSP — total should null-propagate.
  await seedHolding(models, {
    accountId: tfsa.id,
    householdId,
    securityId: xeqt.id,
    statementDate: '2026-05-01',
    quantity: 100,
    marketValue: 5000,
    costBasis: 4500,
  });
  await seedHolding(models, {
    accountId: rrsp.id,
    householdId,
    securityId: xeqt.id,
    statementDate: '2026-05-01',
    quantity: 50,
    marketValue: 2500,
    costBasis: null,
  });
  // TD only in RRSP. Cost basis present in both per-account rows so aggregate is non-null.
  await seedHolding(models, {
    accountId: rrsp.id,
    householdId,
    securityId: td.id,
    statementDate: '2026-05-01',
    quantity: 20,
    marketValue: 2000,
    costBasis: 2100,
  });
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('returns rows sorted by total market value desc', async () => {
  const res = await authed.get('/api/portfolio/by-security');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const rows = res.body.rows as Array<{ symbol: string; totalMarketValue: number }>;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].symbol, 'XEQT');
  assert.equal(rows[1].symbol, 'TD');
  assert.ok(rows[0].totalMarketValue > rows[1].totalMarketValue);
});

test('XEQT aggregates across accounts and null-propagates missing cost basis', async () => {
  const res = await authed.get('/api/portfolio/by-security');
  const rows = res.body.rows as Array<{
    symbol: string;
    totalQuantity: number;
    totalCostBasis: number | null;
    totalMarketValue: number;
    unrealizedGainLoss: number | null;
    accountBreakdown: Array<{
      accountName: string;
      quantity: number;
      costBasis: number | null;
      marketValue: number;
    }>;
  }>;
  const xeqt = rows.find((r) => r.symbol === 'XEQT');
  assert.ok(xeqt);
  assert.equal(Math.round(xeqt.totalQuantity), 150);
  assert.equal(Math.round(xeqt.totalMarketValue), 7500);
  // One account has costBasis null → total + unrealizedGainLoss null.
  assert.equal(xeqt.totalCostBasis, null);
  assert.equal(xeqt.unrealizedGainLoss, null);
  // Per-account breakdown has both accounts.
  assert.equal(xeqt.accountBreakdown.length, 2);
});

test('TD aggregate has non-null cost basis and unrealized G/L', async () => {
  const res = await authed.get('/api/portfolio/by-security');
  const rows = res.body.rows as Array<{
    symbol: string;
    totalCostBasis: number | null;
    unrealizedGainLoss: number | null;
    totalMarketValue: number;
  }>;
  const td = rows.find((r) => r.symbol === 'TD');
  assert.ok(td);
  assert.equal(Math.round(td.totalCostBasis ?? 0), 2100);
  assert.equal(Math.round(td.totalMarketValue), 2000);
  assert.equal(Math.round(td.unrealizedGainLoss ?? 0), -100);
});
