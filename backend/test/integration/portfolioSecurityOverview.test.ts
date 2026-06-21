import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let xeqtId: number;
let testDb: PgTestDb;

before(async () => {
  process.env.NODE_ENV = 'test';
  testDb = await setupPgTestDb('portfolio-overview');
  const mod = await import('../../src/app.js');
  app = mod.default;
  const models = await import('../../src/models');
  const { seedHousehold, seedAccount, seedSecurity, seedHolding, seedSecurityMetadata } = await import(
    './portfolioFixtures.js'
  );
  const seeded = await seedHousehold(models, `ov-${Date.now()}@example.com`);
  const acct = await seedAccount(models, seeded.household.id, seeded.user.id, 'TFSA', 'TFSA01');
  const xeqt = await seedSecurity(models, seeded.household.id, 'XEQT', 'iShares', 'ETF');
  xeqtId = xeqt.id;
  await seedHolding(models, {
    accountId: acct.id, householdId: seeded.household.id, securityId: xeqt.id,
    statementDate: '2026-05-01', quantity: 10, marketValue: 300, costBasis: 280,
  });
  await seedSecurityMetadata(models, xeqt.id, {
    sector: 'Diversified',
    industry: 'Asset Management',
    country: 'Canada',
    exchange: 'TSX',
    description: 'iShares Core Equity ETF Portfolio.',
  });
  authed = testAgent(app);
  authed.jar.setCookie(`cashflow_session=${seeded.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('overview returns cached metadata fields', async () => {
  const res = await authed.get(`/api/portfolio/security/${xeqtId}/overview`);
  assert.equal(res.status, 200);
  assert.equal(res.body.sector, 'Diversified');
  assert.equal(res.body.exchange, 'TSX');
  assert.ok(res.body.metadataFetchedAt);
  assert.equal(res.body.backfill.status, 'fresh');
});
