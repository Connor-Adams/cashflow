/**
 * Unit tests for the lazy backfill module. AV HTTP layer is replaced
 * with stubs via the exposed `__setAvClient` test seam.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-backfill-unit.sqlite');

let models: typeof import('../../src/models');
let backfill: typeof import('../../src/portfolio/backfill');
let sequelize: import('sequelize').Sequelize;

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';
  process.env.ALPHA_VANTAGE_API_KEY = 'test_av_key';

  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'development' },
    stdio: 'pipe',
  });

  models = await import('../../src/models');
  sequelize = models.sequelize;
  backfill = await import('../../src/portfolio/backfill');
});

after(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  // Truncate between tests to isolate state, but keep the single DB connection.
  await models.SecurityDailyPrice.destroy({ where: {}, truncate: true });
  await models.SecurityDividend.destroy({ where: {}, truncate: true });
  await models.Security.destroy({ where: {}, truncate: true });
  backfill.__resetForTests();
});

test('ensureDailyPrices returns never when no rows and enqueues a backfill', async () => {
  const sec = await models.Security.create({
    householdId: 1, symbol: 'TST', name: 'Test', assetType: 'EQUITY', currency: 'USD',
  });
  // Use yesterday as the most-recent bar date so the second ensureDailyPrices
  // call sees it as fresh (latest.date >= yesterdayISODate()).
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yStr = yesterday.toISOString().slice(0, 10);
  const twoDaysAgo = new Date();
  twoDaysAgo.setUTCDate(twoDaysAgo.getUTCDate() - 2);
  const tdStr = twoDaysAgo.toISOString().slice(0, 10);

  backfill.__setAvClient({
    fetchDailyAdjusted: async () => [
      { date: tdStr, open: 1, high: 2, low: 0.5, close: 1.5, adjClose: 1.5, volume: 1000 },
      { date: yStr, open: 1.5, high: 2.5, low: 1, close: 2, adjClose: 2, volume: 2000 },
    ],
    fetchDividends: async () => [],
    fetchOverview: async () => null,
  });
  const first = await backfill.ensureDailyPrices(sec.id);
  assert.equal(first.status, 'never');
  // Wait briefly for the enqueued promise to resolve.
  await new Promise((r) => setTimeout(r, 50));
  const rows = await models.SecurityDailyPrice.findAll({ where: { securityId: sec.id } });
  assert.equal(rows.length, 2);
  const second = await backfill.ensureDailyPrices(sec.id);
  assert.equal(second.status, 'fresh');
});

test('concurrent ensureDailyPrices for same security dedupes', async () => {
  const sec = await models.Security.create({
    householdId: 1, symbol: 'TST2', name: 'Test', assetType: 'EQUITY', currency: 'USD',
  });
  let calls = 0;
  backfill.__setAvClient({
    fetchDailyAdjusted: async () => { calls += 1; await new Promise((r) => setTimeout(r, 30));
      return [{ date: '2026-05-21', open: 1, high: 2, low: 0.5, close: 1.5, adjClose: 1.5, volume: 100 }];
    },
    fetchDividends: async () => [],
    fetchOverview: async () => null,
  });
  const [a, b, c] = await Promise.all([
    backfill.ensureDailyPrices(sec.id),
    backfill.ensureDailyPrices(sec.id),
    backfill.ensureDailyPrices(sec.id),
  ]);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(calls, 1, 'AV called exactly once for concurrent requests');
  assert.ok(['never', 'in_progress'].includes(a.status));
});

test('ensureDailyPrices reports rate_limited when budget exhausted', async () => {
  const sec = await models.Security.create({
    householdId: 1, symbol: 'TST3', name: 'Test', assetType: 'EQUITY', currency: 'USD',
  });
  backfill.__setAvClient({
    fetchDailyAdjusted: async () => [],
    fetchDividends: async () => [],
    fetchOverview: async () => null,
  });
  backfill.__exhaustRateBudget();
  const result = await backfill.ensureDailyPrices(sec.id);
  assert.equal(result.status, 'rate_limited');
  assert.ok(result.nextRetryAt instanceof Date || typeof result.nextRetryAt === 'string');
});
