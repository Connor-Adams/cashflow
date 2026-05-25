/**
 * Scheduler tick integration tests — exercises runQuoteSchedulerTick across
 * disabled, missing-key, budget-exhausted, no-eligible-symbol, refreshed, and
 * rate-limited paths. The cron loop itself isn't started.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-av-scheduler.sqlite');

let Security: typeof import('../../../src/models/Security.js').Security;
let SecurityPrice: typeof import('../../../src/models/SecurityPrice.js').SecurityPrice;
let ProviderJobLog: typeof import('../../../src/models/ProviderJobLog.js').ProviderJobLog;
let runQuoteSchedulerTick: typeof import('../../../src/integrations/alphaVantage/scheduler.js').runQuoteSchedulerTick;

const originalFetch = globalThis.fetch;

const BASE_CONFIG = {
  enabled: true,
  apiKey: 'test-key',
  dailyBudget: 3,
  minAgeHours: 0,
};

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';
  process.env.ALPHA_VANTAGE_API_KEY = 'test-key';

  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'development' },
    stdio: 'pipe',
  });

  const modelsModule = await import('../../../src/models/index.js');
  Security = modelsModule.Security;
  SecurityPrice = modelsModule.SecurityPrice;
  ProviderJobLog = modelsModule.ProviderJobLog;

  const schedulerModule = await import('../../../src/integrations/alphaVantage/scheduler.js');
  runQuoteSchedulerTick = schedulerModule.runQuoteSchedulerTick;
});

beforeEach(async () => {
  await ProviderJobLog.destroy({ where: {} });
  await SecurityPrice.destroy({ where: {} });
  await Security.destroy({ where: {} });
  globalThis.fetch = originalFetch;
});

after(() => {
  globalThis.fetch = originalFetch;
  if (fs.existsSync(dbPath)) {
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  }
});

test('runQuoteSchedulerTick: skipped_disabled when flag is off', async () => {
  const result = await runQuoteSchedulerTick({ ...BASE_CONFIG, enabled: false });
  assert.equal(result.status, 'skipped_disabled');
});

test('runQuoteSchedulerTick: skipped_no_api_key when key absent', async () => {
  const result = await runQuoteSchedulerTick({ ...BASE_CONFIG, apiKey: null });
  assert.equal(result.status, 'skipped_no_api_key');
});

test('runQuoteSchedulerTick: skipped_budget_exhausted when day budget hit', async () => {
  await Security.create({ householdId: 1, symbol: 'AAPL', name: 'Apple', currency: 'USD', assetType: null });
  for (let i = 0; i < 3; i++) {
    await ProviderJobLog.create({
      provider: 'alpha_vantage',
      function: 'GLOBAL_QUOTE',
      symbol: 'AAPL',
      status: 'ok',
      fetchedAt: new Date(),
    });
  }
  const result = await runQuoteSchedulerTick(BASE_CONFIG);
  assert.equal(result.status, 'skipped_budget_exhausted');
});

test('runQuoteSchedulerTick: skipped_no_eligible_symbol when no securities exist', async () => {
  const result = await runQuoteSchedulerTick(BASE_CONFIG);
  assert.equal(result.status, 'skipped_no_eligible_symbol');
});

test('runQuoteSchedulerTick: refreshed path writes SecurityPrice and logs ok', async () => {
  await Security.create({ householdId: 1, symbol: 'AAPL', name: 'Apple', currency: 'USD', assetType: null });
  await Security.create({ householdId: 2, symbol: 'AAPL', name: 'Apple', currency: 'USD', assetType: null });

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        'Global Quote': {
          '05. price': '184.5300',
          '07. latest trading day': '2026-05-23',
        },
      }),
      { status: 200 },
    )) as typeof fetch;

  const result = await runQuoteSchedulerTick(BASE_CONFIG);
  assert.equal(result.status, 'refreshed');
  assert.equal(result.symbol, 'AAPL');

  const prices = await SecurityPrice.findAll({ where: { symbol: 'AAPL' } });
  assert.equal(prices.length, 2, 'one SecurityPrice row per Security with the symbol');
  assert.equal(Number(prices[0].price), 184.53);

  const logs = await ProviderJobLog.findAll({ where: { symbol: 'AAPL', status: 'ok' } });
  assert.equal(logs.length, 1);
});

test('runQuoteSchedulerTick: rate-limited Information payload records rate_limited status', async () => {
  await Security.create({ householdId: 1, symbol: 'AAPL', name: 'Apple', currency: 'USD', assetType: null });

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ Information: 'rate limit reached' }), { status: 200 })) as typeof fetch;

  const result = await runQuoteSchedulerTick(BASE_CONFIG);
  assert.equal(result.status, 'rate_limited');

  const logs = await ProviderJobLog.findAll({ where: { symbol: 'AAPL', status: 'rate_limited' } });
  assert.equal(logs.length, 1);

  const prices = await SecurityPrice.findAll({ where: { symbol: 'AAPL' } });
  assert.equal(prices.length, 0);
});
