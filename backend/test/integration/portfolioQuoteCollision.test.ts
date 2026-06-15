/**
 * Regression test for issue #549 — a Yahoo ticker collision must not override
 * the broker-imported market value.
 *
 * Scenario mirrors the real prod bug: a "Physically backed gold" holding
 * (priced per troy ounce, ~$6,233 CAD/unit, broker market value $3,150.53)
 * has a stored SecurityPrice of $1.56 because the bare symbol "GOLD" resolved
 * to GoldMining Inc (GOLD.TO), a penny stock. The per-unit divergence guard in
 * portfolio/valuation.ts must detect the implausible gap and keep the broker
 * value instead of computing qty * $1.56 = $0.79.
 *
 * A control holding (a normal ETF whose quote is close to the broker per-unit
 * price) confirms a legitimate quote IS still applied.
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
let goldId: number;
let etfId: number;

before(async () => {
  testDb = await setupPgTestDb('quote-collision');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const models = await import('../../src/models');
  const {
    seedHousehold,
    seedAccount,
    seedSecurity,
    seedHolding,
    seedSecurityPrice,
  } = await import('./portfolioFixtures.js');
  const seeded = await seedHousehold(models, `collision-${Date.now()}@example.com`);
  householdId = seeded.household.id;
  userId = seeded.user.id;
  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${seeded.token}; Path=/`);

  const acct = await seedAccount(models, householdId, userId, 'TFSA', 'TFSA01');

  // Collision case: precious-metal holding, broker per-unit ~$6233 CAD.
  const gold = await seedSecurity(
    models,
    householdId,
    'GOLD',
    'Physically backed gold',
    'precious_metal',
  );
  goldId = gold.id;
  await seedHolding(models, {
    accountId: acct.id,
    householdId,
    securityId: gold.id,
    statementDate: '2026-05-01',
    quantity: 0.5054,
    price: 6233.0,
    marketValue: 3150.53,
    costBasis: 3680.0,
  });
  // A stale/colliding penny-stock quote — must be rejected by the guard.
  await seedSecurityPrice(models, {
    securityId: gold.id,
    symbol: 'GOLD',
    price: 1.56,
    currency: 'CAD',
  });

  // Control case: ordinary ETF, quote close to broker per-unit price → used.
  const etf = await seedSecurity(models, householdId, 'XEQT', 'iShares Core', 'ETF');
  etfId = etf.id;
  await seedHolding(models, {
    accountId: acct.id,
    householdId,
    securityId: etf.id,
    statementDate: '2026-05-01',
    quantity: 100,
    price: 30.0,
    marketValue: 3000.0,
    costBasis: 2800.0,
  });
  await seedSecurityPrice(models, {
    securityId: etf.id,
    symbol: 'XEQT',
    price: 32.0,
    currency: 'CAD',
  });
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET / — colliding quote does not collapse GOLD market value', async () => {
  const res = await authed.get('/api/portfolio/');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const holdings = res.body.holdings as Array<{
    securityId: number;
    marketValue: number;
  }>;
  const gold = holdings.find((h) => h.securityId === goldId);
  assert.ok(gold, 'GOLD holding present');
  // Broker value kept, NOT 0.5054 * 1.56 = 0.79.
  assert.ok(
    Math.abs(gold.marketValue - 3150.53) < 0.01,
    `expected ~3150.53, got ${gold.marketValue}`,
  );
});

test('GET / — legitimate quote close to broker price is still applied', async () => {
  const res = await authed.get('/api/portfolio/');
  const holdings = res.body.holdings as Array<{
    securityId: number;
    marketValue: number;
  }>;
  const etf = holdings.find((h) => h.securityId === etfId);
  assert.ok(etf, 'ETF holding present');
  // 100 * 32 = 3200 (quote applied), not the broker 3000.
  assert.ok(
    Math.abs(etf.marketValue - 3200) < 0.01,
    `expected 3200, got ${etf.marketValue}`,
  );
});

test('GET /by-security — GOLD aggregate reflects broker value, real return', async () => {
  const res = await authed.get('/api/portfolio/by-security');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const rows = res.body.rows as Array<{
    securityId: number;
    totalMarketValue: number;
    totalCostBasis: number | null;
    totalReturnPct: number | null;
  }>;
  const gold = rows.find((r) => r.securityId === goldId);
  assert.ok(gold, 'GOLD row present');
  assert.ok(
    Math.abs(gold.totalMarketValue - 3150.53) < 0.01,
    `expected ~3150.53, got ${gold.totalMarketValue}`,
  );
  // Return reflects real cost basis (3150.53 vs 3680 ≈ -14%), NOT -99.98%.
  assert.ok(
    gold.totalReturnPct != null && gold.totalReturnPct > -50,
    `expected a realistic return, got ${gold.totalReturnPct}`,
  );
});
