/**
 * Tests for forwardIncomeScheduler.
 *
 * Pattern: per-file sqlite DB, sequelize-cli migrate in before(), truncate in beforeEach().
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-forward-income-scheduler.sqlite');

let models: typeof import('../../src/models');
let runForwardIncomeTick: typeof import('../../src/portfolio/forwardIncomeScheduler').runForwardIncomeTick;
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
  const schedulerModule = await import('../../src/portfolio/forwardIncomeScheduler');
  runForwardIncomeTick = schedulerModule.runForwardIncomeTick;
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

async function makeHousehold(name = 'Scheduler Test HH') {
  return models.Household.create({ name });
}

async function makeAccount(householdId: number) {
  return models.Account.create({
    householdId,
    name: 'Brokerage',
    owner: 'shared',
    accountType: 'investment',
    currency: 'USD',
  });
}

async function makeSecurity(householdId: number | null, opts: { symbol?: string } = {}) {
  return models.Security.create({
    householdId,
    symbol: opts.symbol ?? 'SCH',
    name: opts.symbol ?? 'Scheduler Security',
    assetType: 'EQUITY',
    currency: 'USD',
  });
}

async function makeHolding(args: {
  accountId: number;
  householdId: number;
  securityId: number;
  statementDate: string;
  quantity: string;
}) {
  const fp = `sched:${args.accountId}:${args.securityId}:${args.statementDate}:${args.quantity}`;
  return models.HoldingSnapshot.create({
    accountId: args.accountId,
    householdId: args.householdId,
    securityId: args.securityId,
    statementDate: args.statementDate,
    quantity: args.quantity,
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

async function makeDividend(args: { securityId: number; exDate: string; amount: string }) {
  return models.SecurityDividend.create({
    securityId: args.securityId,
    exDividendDate: args.exDate,
    declarationDate: null,
    recordDate: null,
    paymentDate: null,
    amount: args.amount,
    currency: 'USD',
    source: 'alpha_vantage',
    fetchedAt: new Date(),
  });
}

// -------------------------
// Tests
// -------------------------

test('runForwardIncomeTick: returns skipped_disabled when enabled=false', async () => {
  const result = await runForwardIncomeTick({ enabled: false });
  assert.equal(result.status, 'skipped_disabled');
});

test('runForwardIncomeTick: runs and produces one projection row for one household + holding', async () => {
  const hh = await makeHousehold();
  const acct = await makeAccount(hh.id);
  const sec = await makeSecurity(hh.id, { symbol: 'SCHTST' });

  await makeHolding({
    accountId: acct.id,
    householdId: hh.id,
    securityId: sec.id,
    statementDate: '2025-05-01',
    quantity: '100',
  });
  await makeDividend({ securityId: sec.id, exDate: '2025-06-15', amount: '0.50' });
  await makeDividend({ securityId: sec.id, exDate: '2025-09-15', amount: '0.50' });
  await makeDividend({ securityId: sec.id, exDate: '2025-12-15', amount: '0.50' });
  await makeDividend({ securityId: sec.id, exDate: '2026-03-15', amount: '0.50' });

  const result = await runForwardIncomeTick({ enabled: true });

  assert.equal(result.status, 'ran');
  assert.equal(result.householdsProcessed, 1);
  assert.equal(result.rebuilt, 1);

  const rows = await models.PortfolioForwardProjection.findAll({ where: { householdId: hh.id } });
  assert.equal(rows.length, 1, 'one PortfolioForwardProjection row should exist');
  assert.equal(rows[0].securityId, sec.id);
});

test('runForwardIncomeTick: sequential ticks both resolve to ran (idempotency)', async () => {
  const hh = await makeHousehold('Sequential HH');
  const acct = await makeAccount(hh.id);
  const sec = await makeSecurity(hh.id, { symbol: 'SEQ' });

  await makeHolding({
    accountId: acct.id,
    householdId: hh.id,
    securityId: sec.id,
    statementDate: '2025-05-01',
    quantity: '50',
  });

  const r1 = await runForwardIncomeTick({ enabled: true });
  const r2 = await runForwardIncomeTick({ enabled: true });

  assert.equal(r1.status, 'ran', 'first tick should ran');
  assert.equal(r2.status, 'ran', 'second sequential tick should also ran');
});
