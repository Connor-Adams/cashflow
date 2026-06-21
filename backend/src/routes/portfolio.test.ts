/**
 * DB-backed tests for the portfolio routes' latest-holdings selection.
 *
 * loadVisibleLatestHoldings must apply the same fully-sold inference as
 * networth/portfolioMarketValueAt (PR #604): a position absent from its
 * account's newest statement was fully sold (imports write no zero-quantity
 * tombstones), so carrying its last snapshot forward forever overstates the
 * Portfolio page and makes it disagree with net worth.
 *
 * Mounts the portfolio router behind a stubbed req.auth (visibleAccountWhere
 * only reads householdId / user.id / globalRole) on the per-process SQLite
 * test DB, exercising the real Sequelize queries via GET /allocation — the
 * leanest consumer of loadVisibleLatestHoldings.
 */
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';

process.env.DATABASE_PATH = ':memory:';

let models: typeof import('../models');
let app: express.Express;
let household: { id: number };

before(async () => {
  models = await import('../models');
  await models.sequelize.sync({ force: true });
  const portfolioRouter = (await import('./portfolio')).default;
  app = express();
  app.use((req, _res, next) => {
    req.auth = {
      user: { id: 1, globalRole: 'member' },
      household,
      role: 'owner',
    } as unknown as NonNullable<typeof req.auth>;
    next();
  });
  app.use(portfolioRouter);
});

after(async () => {
  await models.sequelize.close();
});

beforeEach(async () => {
  await models.HoldingSnapshot.destroy({ where: {}, truncate: true });
  await models.Security.destroy({ where: {}, truncate: true });
  await models.Account.destroy({ where: {}, truncate: true });
  await models.Household.destroy({ where: {}, truncate: true });
  household = await models.Household.create({ name: 'Portfolio Test HH' });
});

async function seedAccount(name: string): Promise<number> {
  const acc = await models.Account.create({
    householdId: household.id,
    ownerUserId: null,
    owner: 'me',
    visibility: 'shared',
    name,
    accountType: 'investment',
    defaultCurrency: 'CAD',
    shortCode: name.slice(0, 3).toUpperCase(),
  });
  return acc.id;
}

async function seedSecurity(symbol: string) {
  return models.Security.create({
    symbol,
    name: symbol,
    currency: 'CAD',
  } as never);
}

async function seedHolding(
  accountId: number,
  securityId: number,
  statementDate: string,
  quantity: string,
  marketValue: string,
  costBasis?: string,
): Promise<void> {
  await models.HoldingSnapshot.create({
    accountId,
    securityId,
    statementDate,
    quantity,
    marketValue,
    costBasis,
    currency: 'CAD',
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    importBatch: 'portfolio-test',
  } as never);
}

test('GET /allocation: position absent from the account newest statement is excluded', async () => {
  const acc = await seedAccount('Brokerage');
  const kept = await seedSecurity('KEPT');
  const sold = await seedSecurity('SOLD');
  // January statement holds both; the February statement lists only KEPT —
  // SOLD was fully liquidated and simply stops appearing.
  await seedHolding(acc, kept.id, '2026-01-31', '10', '1000');
  await seedHolding(acc, sold.id, '2026-01-31', '5', '250');
  await seedHolding(acc, kept.id, '2026-02-28', '10', '1100');

  const res = await request(app).get('/allocation');
  assert.equal(res.status, 200);
  const symbols = (res.body.bySecurity as Array<{ symbol: string }>).map((r) => r.symbol);
  assert.deepEqual(symbols, ['KEPT']);
  assert.equal(res.body.bySecurity[0].marketValue, 1100);
});

test('GET /security/:id: fully-sold position reports zero current values but keeps history', async () => {
  const acc = await seedAccount('Brokerage');
  const kept = await seedSecurity('KEPT');
  const sold = await seedSecurity('SOLD');
  // January statement holds both; the February statement lists only KEPT —
  // SOLD was fully liquidated and simply stops appearing. The /security/:id
  // query is scoped to one security, so the fix must look up the account's
  // newest statement date across ALL securities.
  await seedHolding(acc, kept.id, '2026-01-31', '10', '1000', '900');
  await seedHolding(acc, sold.id, '2026-01-31', '5', '250', '200');
  await seedHolding(acc, kept.id, '2026-02-28', '10', '1100', '900');

  const res = await request(app).get(`/security/${sold.id}`);
  assert.equal(res.status, 200);

  assert.equal((res.body.perAccount as unknown[]).length, 1);
  const row = res.body.perAccount[0] as {
    currentQuantity: number;
    currentMarketValue: number;
    currentCostBasis: number;
    currentUnrealizedGainLoss: number | null;
  };
  assert.equal(row.currentQuantity, 0);
  assert.equal(row.currentMarketValue, 0);
  assert.equal(row.currentCostBasis, 0);
  assert.equal(row.currentUnrealizedGainLoss, null);

  assert.equal(res.body.combined.currentQuantity, 0);
  assert.equal(res.body.combined.currentMarketValue, 0);
  assert.equal(res.body.combined.currentCostBasis, 0);

  // Snapshot history is untouched — the drill page still shows the past.
  const history = res.body.holdings as Array<{ statementDate: string }>;
  assert.equal(history.length, 1);
  assert.equal(history[0].statementDate, '2026-01-31');
});

test('GET /security/:id: newer statement on another account does not zero this account', async () => {
  const a1 = await seedAccount('A1');
  const a2 = await seedAccount('A2');
  const sec = await seedSecurity('VFV');
  // a1's newest statement is January — its position is current for a1 even
  // though a2 has a newer statement. A global-newest-date check would
  // wrongly zero a1 here; staleness must be judged per account.
  await seedHolding(a1, sec.id, '2026-01-31', '10', '1000', '900');
  await seedHolding(a2, sec.id, '2026-02-28', '3', '300', '280');

  const res = await request(app).get(`/security/${sec.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.combined.currentQuantity, 13);
  assert.equal(res.body.combined.currentMarketValue, 1300);
  assert.equal(res.body.combined.currentCostBasis, 1180);
});

test('GET /allocation: newer statement on one account does not hide another account positions', async () => {
  const a1 = await seedAccount('A1');
  const a2 = await seedAccount('A2');
  const sec = await seedSecurity('VFV');
  // a1's newest statement is January — its position is current for a1 even
  // though a2 has a newer statement.
  await seedHolding(a1, sec.id, '2026-01-31', '10', '1000');
  await seedHolding(a2, sec.id, '2026-02-28', '3', '300');

  const res = await request(app).get('/allocation');
  assert.equal(res.status, 200);
  assert.equal((res.body.byAccount as unknown[]).length, 2);
  const total = (res.body.byAccount as Array<{ marketValue: number }>).reduce(
    (s, r) => s + r.marketValue,
    0,
  );
  assert.equal(total, 1300);
});
