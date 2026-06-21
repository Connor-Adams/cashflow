/**
 * Integration tests for daily-snapshot stale-invalidation hooks.
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
const dbPath = path.join(backendRoot, 'data', 'test-daily-snapshot-stale.sqlite');

let models: typeof import('../models');

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
  models = await import('../models');
});

after(async () => { await models.sequelize.close(); });

beforeEach(async () => {
  await models.PortfolioDailySnapshot.destroy({ where: {}, truncate: true });
  await models.InvestmentActivity.destroy({ where: {}, truncate: true });
  await models.Account.destroy({ where: {}, truncate: true });
  await models.Household.destroy({ where: {}, truncate: true });
});

async function seedSnapshot(args: { householdId: number; accountId: number; date: string }) {
  return models.PortfolioDailySnapshot.create({
    householdId: args.householdId, accountId: args.accountId, date: args.date,
    marketValueNative: '0', currency: 'CAD', fxRateToCad: '1', marketValueCad: '0',
    cashFlowNative: '0', cashFlowCad: '0', isPartial: false, missingDataReasons: null,
    computedAt: new Date(),
  });
}

test('InvestmentActivity.create deletes snapshots from tradeDate forward', async () => {
  const hh = await models.Household.create({ id: 1, name: 'A', benchmarkSymbol: 'SPY' });
  const acct = await models.Account.create({ id: 10, householdId: hh.id, name: 'X', owner: 'shared', accountType: 'investment', defaultCurrency: 'CAD' });
  await seedSnapshot({ householdId: hh.id, accountId: acct.id, date: '2026-01-01' });
  await seedSnapshot({ householdId: hh.id, accountId: acct.id, date: '2026-06-15' });
  await seedSnapshot({ householdId: hh.id, accountId: acct.id, date: '2026-12-01' });

  await models.InvestmentActivity.create({
    accountId: acct.id, householdId: hh.id, securityId: null,
    activityType: 'transfer', tradeDate: '2026-06-15',
    amount: '100', currency: 'CAD', description: 'X',
    sourceRowFingerprint: 'fp1', importBatch: 'b1',
  });

  await new Promise((r) => setImmediate(r));
  const remaining = await models.PortfolioDailySnapshot.findAll({ where: { householdId: hh.id }, order: [['date', 'ASC']] });
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].date, '2026-01-01');
});

test('InvestmentActivity.destroy deletes snapshots from tradeDate forward', async () => {
  const hh = await models.Household.create({ id: 2, name: 'B', benchmarkSymbol: 'SPY' });
  const acct = await models.Account.create({ id: 20, householdId: hh.id, name: 'Y', owner: 'shared', accountType: 'investment', defaultCurrency: 'CAD' });
  const act = await models.InvestmentActivity.create({
    accountId: acct.id, householdId: hh.id, securityId: null,
    activityType: 'transfer', tradeDate: '2026-03-01',
    amount: '100', currency: 'CAD', description: 'X',
    sourceRowFingerprint: 'fp2', importBatch: 'b1',
  });
  await new Promise((r) => setImmediate(r));
  await seedSnapshot({ householdId: hh.id, accountId: acct.id, date: '2026-02-01' });
  await seedSnapshot({ householdId: hh.id, accountId: acct.id, date: '2026-04-01' });

  await act.destroy();
  await new Promise((r) => setImmediate(r));
  const remaining = await models.PortfolioDailySnapshot.findAll({ where: { householdId: hh.id } });
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].date, '2026-02-01');
});

test('unrelated household activity does not delete other households', async () => {
  const a = await models.Household.create({ id: 3, name: 'A', benchmarkSymbol: 'SPY' });
  const b = await models.Household.create({ id: 4, name: 'B', benchmarkSymbol: 'SPY' });
  const acctA = await models.Account.create({ id: 30, householdId: a.id, name: 'X', owner: 'shared', accountType: 'investment', defaultCurrency: 'CAD' });
  const acctB = await models.Account.create({ id: 40, householdId: b.id, name: 'Y', owner: 'shared', accountType: 'investment', defaultCurrency: 'CAD' });
  await seedSnapshot({ householdId: a.id, accountId: acctA.id, date: '2026-01-01' });
  await seedSnapshot({ householdId: b.id, accountId: acctB.id, date: '2026-01-01' });

  await models.InvestmentActivity.create({
    accountId: acctA.id, householdId: a.id, securityId: null,
    activityType: 'transfer', tradeDate: '2025-12-01',
    amount: '100', currency: 'CAD', description: 'X',
    sourceRowFingerprint: 'fp3', importBatch: 'b1',
  });
  await new Promise((r) => setImmediate(r));
  const bRows = await models.PortfolioDailySnapshot.findAll({ where: { householdId: b.id } });
  assert.equal(bRows.length, 1);
});
