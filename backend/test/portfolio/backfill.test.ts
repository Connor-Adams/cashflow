/**
 * Unit tests for the lazy backfill module. The Yahoo Finance HTTP layer is
 * replaced with stubs via the `__setYahooFetchers` test seam. Yahoo has no
 * per-key quota so there is no budget gate to exercise — rate-limit handling
 * is verified by having the stub throw `YahooFinanceError`.
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
  await models.SecurityDailyPrice.destroy({ where: {}, truncate: true });
  await models.SecurityDividend.destroy({ where: {}, truncate: true });
  await models.Security.destroy({ where: {}, truncate: true });
  await models.ProviderJobLog.destroy({ where: {}, truncate: true });
  backfill.__resetForTests();
});

test('ensureDailyPrices returns never when no rows and enqueues a backfill', async () => {
  const sec = await models.Security.create({
    householdId: 1, symbol: 'TST', name: 'Test', assetType: 'EQUITY', currency: 'USD',
  });
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yStr = yesterday.toISOString().slice(0, 10);
  const twoDaysAgo = new Date();
  twoDaysAgo.setUTCDate(twoDaysAgo.getUTCDate() - 2);
  const tdStr = twoDaysAgo.toISOString().slice(0, 10);

  backfill.__setYahooFetchers({
    fetchQuote: async () => null,
    fetchDailyHistory: async () => [
      { date: tdStr, open: 1, high: 2, low: 0.5, close: 1.5, adjClose: 1.5, volume: 1000 },
      { date: yStr, open: 1.5, high: 2.5, low: 1, close: 2, adjClose: 2, volume: 2000 },
    ],
    fetchDividends: async () => [],
    fetchOverview: async () => null,
  });
  const first = await backfill.ensureDailyPrices(sec.id);
  assert.equal(first.status, 'never');
  await new Promise((r) => setTimeout(r, 60));
  const rows = await models.SecurityDailyPrice.findAll({ where: { securityId: sec.id } });
  assert.equal(rows.length, 2);
  const second = await backfill.ensureDailyPrices(sec.id);
  assert.equal(second.status, 'fresh');

  const okLog = await models.ProviderJobLog.findOne({
    where: { function: 'DAILY_HISTORY', symbol: 'TST', status: 'ok' },
  });
  assert.ok(okLog, 'a provider_job_log row should be recorded for the successful fetch');
});

test('ensureDailyPrices appends .TO for CAD-listed securities', async () => {
  const sec = await models.Security.create({
    householdId: 1, symbol: 'XEQT', name: 'iShares Core Equity', assetType: 'EQUITY', currency: 'CAD',
  });
  let observedSymbol: string | null = null;
  backfill.__setYahooFetchers({
    fetchQuote: async () => null,
    fetchDailyHistory: async (symbol) => {
      observedSymbol = symbol;
      return [{ date: '2026-05-21', open: 44, high: 45, low: 43, close: 44.5, adjClose: 44.5, volume: 100 }];
    },
    fetchDividends: async () => [],
    fetchOverview: async () => null,
  });

  await backfill.ensureDailyPrices(sec.id);
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(observedSymbol, 'XEQT.TO', 'Yahoo client should be called with the .TO-suffixed symbol');
  const okLog = await models.ProviderJobLog.findOne({
    where: { function: 'DAILY_HISTORY', symbol: 'XEQT.TO', status: 'ok' },
  });
  assert.ok(okLog, 'job log should record the Yahoo-mapped symbol');
});

test('concurrent ensureDailyPrices for same security dedupes', async () => {
  const sec = await models.Security.create({
    householdId: 1, symbol: 'TST2', name: 'Test', assetType: 'EQUITY', currency: 'USD',
  });
  let calls = 0;
  backfill.__setYahooFetchers({
    fetchQuote: async () => null,
    fetchDailyHistory: async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 30));
      return [{ date: '2026-05-21', open: 1, high: 2, low: 0.5, close: 1.5, adjClose: 1.5, volume: 100 }];
    },
    fetchDividends: async () => [],
    fetchOverview: async () => null,
  });
  const [a] = await Promise.all([
    backfill.ensureDailyPrices(sec.id),
    backfill.ensureDailyPrices(sec.id),
    backfill.ensureDailyPrices(sec.id),
  ]);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(calls, 1, 'Yahoo called exactly once for concurrent requests');
  assert.ok(['never', 'in_progress'].includes(a.status));
});

test('ensureOverview persists metadata + logs ok', async () => {
  const sec = await models.Security.create({
    householdId: 1, symbol: 'AAPL', name: 'Apple', assetType: 'EQUITY', currency: 'USD',
  });
  backfill.__setYahooFetchers({
    fetchQuote: async () => null,
    fetchDailyHistory: async () => [],
    fetchDividends: async () => [],
    fetchOverview: async () => ({
      sector: 'Technology',
      industry: 'Consumer Electronics',
      country: 'United States',
      exchange: 'NMS',
      description: 'Designs phones.',
      raw: { symbol: 'AAPL' },
    }),
  });

  const first = await backfill.ensureOverview(sec.id);
  assert.equal(first.status, 'never');
  await new Promise((r) => setTimeout(r, 60));

  const refreshed = await models.Security.findByPk(sec.id);
  assert.ok(refreshed);
  assert.equal(refreshed.metadata?.sector, 'Technology');
  assert.ok(refreshed.metadataFetchedAt instanceof Date);

  const okLog = await models.ProviderJobLog.findOne({
    where: { function: 'OVERVIEW', symbol: 'AAPL', status: 'ok' },
  });
  assert.ok(okLog, 'a provider_job_log row should be recorded for OVERVIEW');

  const second = await backfill.ensureOverview(sec.id);
  assert.equal(second.status, 'fresh');
});

test('ensureDividends rate-limit response is recorded as rate_limited', async () => {
  const sec = await models.Security.create({
    householdId: 1, symbol: 'DVT', name: 'Div Test', assetType: 'EQUITY', currency: 'USD',
  });
  const { YahooFinanceError } = await import('../../src/integrations/yahoo/client');
  backfill.__setYahooFetchers({
    fetchQuote: async () => null,
    fetchDailyHistory: async () => [],
    fetchDividends: async () => {
      throw new YahooFinanceError('rate limited by upstream', 429);
    },
    fetchOverview: async () => null,
  });

  const first = await backfill.ensureDividends(sec.id);
  assert.equal(first.status, 'never');
  await new Promise((r) => setTimeout(r, 60));

  const log = await models.ProviderJobLog.findOne({
    where: { function: 'DIVIDENDS', symbol: 'DVT' },
  });
  assert.ok(log);
  assert.equal(log.status, 'rate_limited');
});
