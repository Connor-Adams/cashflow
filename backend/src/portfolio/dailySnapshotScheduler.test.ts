import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-daily-snapshot-scheduler.sqlite');

let models: typeof import('../models');
let scheduler: typeof import('./dailySnapshotScheduler');

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
  scheduler = await import('./dailySnapshotScheduler');
});

after(async () => { await models.sequelize.close(); });

beforeEach(async () => {
  await models.PortfolioDailySnapshot.destroy({ where: {}, truncate: true });
  await models.InvestmentActivity.destroy({ where: {}, truncate: true });
  await models.Account.destroy({ where: {}, truncate: true });
  await models.Household.destroy({ where: {}, truncate: true });
});

test('runDailySnapshotTick({ enabled: false }) returns skipped_disabled', async () => {
  const r = await scheduler.runDailySnapshotTick({ enabled: false });
  assert.equal(r.status, 'skipped_disabled');
});

test('runDailySnapshotTick({ enabled: true }) runs and builds snapshots', async () => {
  const hh = await models.Household.create({ id: 1, name: 'A', benchmarkSymbol: 'SPY' });
  const acct = await models.Account.create({ id: 10, householdId: hh.id, name: 'X', owner: 'shared', accountType: 'investment', defaultCurrency: 'CAD' });
  await models.InvestmentActivity.create({
    accountId: acct.id, householdId: hh.id, securityId: null,
    activityType: 'transfer', tradeDate: '2026-01-01',
    amount: '1000', currency: 'CAD', description: 'X',
    sourceRowFingerprint: 'fp1', importBatch: 'b1',
  });
  await new Promise((r) => setImmediate(r));
  const r = await scheduler.runDailySnapshotTick({ enabled: true });
  assert.equal(r.status, 'ran');
  assert.ok((r.householdsProcessed ?? 0) >= 1);
});

test('sequential ticks both resolve to ran', async () => {
  const r1 = await scheduler.runDailySnapshotTick({ enabled: true });
  const r2 = await scheduler.runDailySnapshotTick({ enabled: true });
  assert.equal(r1.status, 'ran');
  assert.equal(r2.status, 'ran');
});
