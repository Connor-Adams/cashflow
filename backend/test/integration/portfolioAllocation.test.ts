/**
 * Integration tests for GET /api/portfolio/allocation. Seeds two
 * investment accounts plus a mix of holdings across three securities
 * spanning two asset types and two currencies, then verifies the
 * three bucket arrays (byAssetType, bySecurity, byAccount) sum +
 * percentage correctly and bucket per-currency.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { testAgent, testRequest } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let testDb: PgTestDb;
let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let householdId: number;
let userId: number;

before(async () => {
  testDb = await setupPgTestDb('portfolio-allocation');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const models = await import('../../src/models');
  const { seedHousehold, seedAccount, seedSecurity, seedHolding } = await import(
    './portfolioFixtures.js'
  );
  const seeded = await seedHousehold(models, `alloc-${Date.now()}@example.com`);
  householdId = seeded.household.id;
  userId = seeded.user.id;
  authed = testAgent(app);
  authed.jar.setCookie(`cashflow_session=${seeded.token}; Path=/`);

  // Two investment accounts.
  const tfsa = await seedAccount(models, householdId, userId, 'TFSA', 'TFSA01');
  const rrsp = await seedAccount(models, householdId, userId, 'RRSP', 'RRSP01');

  // Three securities: 2 CAD (one ETF, one equity) and 1 USD ETF.
  const xeqt = await seedSecurity(models, householdId, 'XEQT', 'iShares Core Equity', 'ETF', 'CAD');
  const td = await seedSecurity(models, householdId, 'TD', 'Toronto Dominion', 'EQUITY', 'CAD');
  const vti = await seedSecurity(models, householdId, 'VTI', 'Vanguard Total US', 'ETF', 'USD');

  // Holdings: TFSA holds XEQT(CAD) 100u@$50 = 5000 + VTI(USD) 10u@$200 = 2000USD.
  // RRSP holds XEQT(CAD) 50u@$50 = 2500 + TD(CAD) 20u@$100 = 2000.
  await seedHolding(models, {
    accountId: tfsa.id,
    householdId,
    securityId: xeqt.id,
    statementDate: '2026-05-01',
    quantity: 100,
    marketValue: 5000,
    costBasis: 4500,
    currency: 'CAD',
  });
  await seedHolding(models, {
    accountId: tfsa.id,
    householdId,
    securityId: vti.id,
    statementDate: '2026-05-01',
    quantity: 10,
    marketValue: 2000,
    costBasis: 1800,
    currency: 'USD',
  });
  await seedHolding(models, {
    accountId: rrsp.id,
    householdId,
    securityId: xeqt.id,
    statementDate: '2026-05-01',
    quantity: 50,
    marketValue: 2500,
    costBasis: 2300,
    currency: 'CAD',
  });
  await seedHolding(models, {
    accountId: rrsp.id,
    householdId,
    securityId: td.id,
    statementDate: '2026-05-01',
    quantity: 20,
    marketValue: 2000,
    costBasis: 2100,
    currency: 'CAD',
  });
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/portfolio/allocation returns three bucket arrays', async () => {
  const res = await authed.get('/api/portfolio/allocation');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(Array.isArray(res.body.byAssetType));
  assert.ok(Array.isArray(res.body.bySecurity));
  assert.ok(Array.isArray(res.body.byAccount));
});

test('byAssetType groups across accounts and partitions by currency', async () => {
  const res = await authed.get('/api/portfolio/allocation');
  const cad = res.body.byAssetType.filter(
    (r: { currency: string }) => r.currency === 'CAD',
  );
  const usd = res.body.byAssetType.filter(
    (r: { currency: string }) => r.currency === 'USD',
  );

  // CAD: ETF = 5000+2500 = 7500, EQUITY (TD) = 2000.
  const cadEtf = cad.find((r: { assetType: string }) => r.assetType === 'ETF');
  const cadEq = cad.find((r: { assetType: string }) => r.assetType === 'EQUITY');
  assert.ok(cadEtf, `expected ETF/CAD row, got ${JSON.stringify(cad)}`);
  assert.ok(cadEq, `expected EQUITY/CAD row, got ${JSON.stringify(cad)}`);
  assert.equal(Math.round(cadEtf.marketValue), 7500);
  assert.equal(Math.round(cadEq.marketValue), 2000);

  // Percentages should sum to 100 within CAD, never mixed across currencies.
  const cadPctSum = cad.reduce(
    (s: number, r: { percentage: number }) => s + r.percentage,
    0,
  );
  assert.ok(
    Math.abs(cadPctSum - 100) < 0.1,
    `CAD percentages should sum to ~100, got ${cadPctSum}`,
  );

  // USD: only VTI ETF.
  assert.equal(usd.length, 1);
  assert.equal(usd[0].assetType, 'ETF');
  assert.equal(Math.round(usd[0].marketValue), 2000);
  assert.equal(Math.round(usd[0].percentage), 100);
});

test('bySecurity returns one row per security+currency', async () => {
  const res = await authed.get('/api/portfolio/allocation');
  const byId = new Map<string, { marketValue: number; percentage: number }>(
    res.body.bySecurity.map((r: { symbol: string; currency: string; marketValue: number; percentage: number }) => [
      `${r.symbol}|${r.currency}`,
      r,
    ]),
  );
  // XEQT shows up combined across both accounts.
  const xeqt = byId.get('XEQT|CAD');
  assert.ok(xeqt);
  assert.equal(Math.round(xeqt.marketValue), 7500);
  const vti = byId.get('VTI|USD');
  assert.ok(vti);
  assert.equal(Math.round(vti.marketValue), 2000);
});

test('byAccount returns one row per account+currency', async () => {
  const res = await authed.get('/api/portfolio/allocation');
  // TFSA has CAD + USD; RRSP has only CAD.
  const tfsaCad = res.body.byAccount.find(
    (r: { accountName: string; currency: string }) =>
      r.accountName === 'TFSA' && r.currency === 'CAD',
  );
  const tfsaUsd = res.body.byAccount.find(
    (r: { accountName: string; currency: string }) =>
      r.accountName === 'TFSA' && r.currency === 'USD',
  );
  const rrspCad = res.body.byAccount.find(
    (r: { accountName: string; currency: string }) =>
      r.accountName === 'RRSP' && r.currency === 'CAD',
  );
  assert.ok(tfsaCad);
  assert.ok(tfsaUsd);
  assert.ok(rrspCad);
  assert.equal(Math.round(tfsaCad.marketValue), 5000);
  assert.equal(Math.round(tfsaUsd.marketValue), 2000);
  assert.equal(Math.round(rrspCad.marketValue), 4500);
});

test('Unauthenticated request is rejected', async () => {
  const res = await testRequest(app).get('/api/portfolio/allocation');
  assert.ok(res.status === 401 || res.status === 403);
});
