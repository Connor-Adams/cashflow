/**
 * Integration tests for Sequelize stale-invalidation hooks.
 *
 * Pattern: per-file sqlite DB, sequelize-cli migrate in before(), truncate in beforeEach(),
 * inline factory helpers only — no shared testUtils.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-forward-income-stale.sqlite');

let models: typeof import('../../src/models');
let sequelize: import('sequelize').Sequelize;

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

  models = await import('../../src/models');
  sequelize = models.sequelize;
});

after(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  await models.PortfolioForwardProjection.destroy({ where: {}, truncate: true });
  await models.InvestmentActivity.destroy({ where: {}, truncate: true });
  await models.SecurityDividend.destroy({ where: {}, truncate: true });
  await models.HoldingSnapshot.destroy({ where: {}, truncate: true });
  await models.Security.destroy({ where: {}, truncate: true });
  await models.Account.destroy({ where: {}, truncate: true });
  await models.Household.destroy({ where: {}, truncate: true });
});

// -------------------------
// Inline factory helpers
// -------------------------

async function makeHousehold(name = 'Test Household') {
  return models.Household.create({ name });
}

async function makeAccount(householdId: number, opts: { name?: string; type?: string } = {}) {
  return models.Account.create({
    householdId,
    name: opts.name ?? 'Brokerage',
    owner: 'shared',
    accountType: opts.type ?? 'investment',
    currency: 'USD',
  });
}

async function makeSecurity(householdId: number | null, opts: { symbol?: string; currency?: string } = {}) {
  return models.Security.create({
    householdId,
    symbol: opts.symbol ?? 'TST',
    name: opts.symbol ?? 'Test Security',
    assetType: 'EQUITY',
    currency: opts.currency ?? 'USD',
  });
}

async function seedFreshProjection(householdId: number, securityId: number) {
  return models.PortfolioForwardProjection.create({
    householdId,
    securityId,
    qtyBasis: '100',
    annualDividendPerShare: '0',
    annualInterestPerShare: '0',
    projectedAnnualIncomeNative: '0',
    currency: 'CAD',
    cadenceLabel: 'none',
    medianSpacingDays: null,
    cvPct: null,
    unreliable: false,
    nextExDivDates: [],
    computedAt: new Date(),
    staleAt: null,
  });
}

async function makeActivity(args: {
  accountId: number;
  householdId: number;
  securityId: number;
  activityType: string;
}) {
  const fp = `test:${args.accountId}:${args.securityId}:${args.activityType}:${Date.now()}:${Math.random()}`;
  return models.InvestmentActivity.create({
    accountId: args.accountId,
    householdId: args.householdId,
    securityId: args.securityId,
    activityType: args.activityType,
    tradeDate: '2025-06-01',
    settlementDate: null,
    description: `Test ${args.activityType}`,
    quantity: null,
    price: null,
    amount: '100',
    fees: null,
    splitRatio: null,
    currency: 'USD',
    sourceReference: 'test',
    sourceRowFingerprint: fp,
    importBatch: 'test',
  });
}

async function makeHolding(args: {
  accountId: number;
  householdId: number;
  securityId: number;
}) {
  const fp = `test-snap:${args.accountId}:${args.securityId}:${Date.now()}:${Math.random()}`;
  return models.HoldingSnapshot.create({
    accountId: args.accountId,
    householdId: args.householdId,
    securityId: args.securityId,
    statementDate: '2025-05-01',
    quantity: '100',
    price: null,
    marketValue: null,
    costBasis: null,
    unrealizedGainLoss: null,
    currency: 'USD',
    sourceReference: 'test',
    sourceRowFingerprint: fp,
    importBatch: 'test',
  });
}

// -------------------------
// Tests
// -------------------------

test('hooks: InvestmentActivity.create with type=interest marks projection stale', async () => {
  const hh = await makeHousehold();
  const acct = await makeAccount(hh.id);
  const sec = await makeSecurity(hh.id, { symbol: 'BOND' });

  const proj = await seedFreshProjection(hh.id, sec.id);
  assert.equal(proj.staleAt, null, 'staleAt should be null before hook fires');

  await makeActivity({ accountId: acct.id, householdId: hh.id, securityId: sec.id, activityType: 'interest' });

  const updated = await models.PortfolioForwardProjection.findByPk(proj.id);
  assert.ok(updated!.staleAt !== null, 'staleAt should be set after interest activity create');
});

test('hooks: InvestmentActivity.create with type=buy marks projection stale', async () => {
  const hh = await makeHousehold();
  const acct = await makeAccount(hh.id);
  const sec = await makeSecurity(hh.id, { symbol: 'AAPL' });

  const proj = await seedFreshProjection(hh.id, sec.id);
  assert.equal(proj.staleAt, null);

  await makeActivity({ accountId: acct.id, householdId: hh.id, securityId: sec.id, activityType: 'buy' });

  const updated = await models.PortfolioForwardProjection.findByPk(proj.id);
  assert.ok(updated!.staleAt !== null, 'staleAt should be set after buy activity create');
});

test('hooks: SecurityDividend.create marks all household rows for that security stale', async () => {
  const hhA = await makeHousehold('Household A');
  const hhB = await makeHousehold('Household B');
  const sec = await makeSecurity(null, { symbol: 'SHARED' });

  const projA = await seedFreshProjection(hhA.id, sec.id);
  const projB = await seedFreshProjection(hhB.id, sec.id);

  // Fire the hook by creating a SecurityDividend
  await models.SecurityDividend.create({
    securityId: sec.id,
    exDividendDate: '2025-09-15',
    declarationDate: null,
    recordDate: null,
    paymentDate: null,
    amount: '0.50',
    currency: 'USD',
    source: 'alpha_vantage',
    fetchedAt: new Date(),
  });

  const updatedA = await models.PortfolioForwardProjection.findByPk(projA.id);
  const updatedB = await models.PortfolioForwardProjection.findByPk(projB.id);
  assert.ok(updatedA!.staleAt !== null, 'staleAt should be set for household A');
  assert.ok(updatedB!.staleAt !== null, 'staleAt should be set for household B');
});

test('hooks: HoldingSnapshot.create marks matching household+security row stale', async () => {
  const hh = await makeHousehold();
  const acct = await makeAccount(hh.id);
  const sec = await makeSecurity(hh.id, { symbol: 'VTI' });

  const proj = await seedFreshProjection(hh.id, sec.id);
  assert.equal(proj.staleAt, null);

  await makeHolding({ accountId: acct.id, householdId: hh.id, securityId: sec.id });

  const updated = await models.PortfolioForwardProjection.findByPk(proj.id);
  assert.ok(updated!.staleAt !== null, 'staleAt should be set after HoldingSnapshot create');
});

test('hooks: unrelated security activity does not mark other security stale', async () => {
  const hh = await makeHousehold();
  const acct = await makeAccount(hh.id);
  const secA = await makeSecurity(hh.id, { symbol: 'AAA' });
  const secB = await makeSecurity(hh.id, { symbol: 'BBB' });

  const projA = await seedFreshProjection(hh.id, secA.id);
  // Activity for secB should not touch projA
  await makeActivity({ accountId: acct.id, householdId: hh.id, securityId: secB.id, activityType: 'buy' });

  const updatedA = await models.PortfolioForwardProjection.findByPk(projA.id);
  assert.equal(updatedA!.staleAt, null, 'staleAt for secA should remain null when secB activity fires');
});
