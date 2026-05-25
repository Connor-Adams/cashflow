/**
 * Scheduler tick integration tests — exercises runQuoteSchedulerTick across
 * disabled, missing-key, budget-exhausted, no-eligible-symbol, refreshed,
 * rate-limited, OVERVIEW dispatch, and DIVIDENDS dispatch paths. The cron
 * loop itself isn't started.
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
let SecurityDividend: typeof import('../../../src/models/SecurityDividend.js').SecurityDividend;
let ProviderJobLog: typeof import('../../../src/models/ProviderJobLog.js').ProviderJobLog;
let runQuoteSchedulerTick: typeof import('../../../src/integrations/alphaVantage/scheduler.js').runQuoteSchedulerTick;

const originalFetch = globalThis.fetch;

const BASE_CONFIG = {
  enabled: true,
  apiKey: 'test-key',
  dailyBudget: 5,
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
  SecurityDividend = modelsModule.SecurityDividend;
  ProviderJobLog = modelsModule.ProviderJobLog;

  const schedulerModule = await import('../../../src/integrations/alphaVantage/scheduler.js');
  runQuoteSchedulerTick = schedulerModule.runQuoteSchedulerTick;
});

beforeEach(async () => {
  await ProviderJobLog.destroy({ where: {} });
  await SecurityPrice.destroy({ where: {} });
  await SecurityDividend.destroy({ where: {} });
  await Security.destroy({ where: {} });
  globalThis.fetch = originalFetch;
});

after(() => {
  globalThis.fetch = originalFetch;
  if (fs.existsSync(dbPath)) {
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  }
});

/**
 * Seeds successful OVERVIEW + DIVIDENDS rows so the picker only considers
 * GLOBAL_QUOTE on the next tick. Avoids mocking the wrong response shape
 * when a test wants to exercise GLOBAL_QUOTE specifically.
 */
async function seedNonQuoteFresh(symbol: string): Promise<void> {
  await ProviderJobLog.bulkCreate([
    {
      provider: 'alpha_vantage',
      function: 'OVERVIEW',
      symbol,
      status: 'ok',
      fetchedAt: new Date(),
    },
    {
      provider: 'alpha_vantage',
      function: 'DIVIDENDS',
      symbol,
      status: 'ok',
      fetchedAt: new Date(),
    },
  ]);
}

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
  for (let i = 0; i < 5; i++) {
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

test('runQuoteSchedulerTick: GLOBAL_QUOTE path writes SecurityPrice and logs ok', async () => {
  await Security.create({ householdId: 1, symbol: 'AAPL', name: 'Apple', currency: 'USD', assetType: null });
  await Security.create({ householdId: 2, symbol: 'AAPL', name: 'Apple', currency: 'USD', assetType: null });
  await seedNonQuoteFresh('AAPL');

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
  assert.equal(result.function, 'GLOBAL_QUOTE');

  const prices = await SecurityPrice.findAll({ where: { symbol: 'AAPL' } });
  assert.equal(prices.length, 2, 'one SecurityPrice row per Security with the symbol');
  assert.equal(Number(prices[0].price), 184.53);

  const logs = await ProviderJobLog.findAll({
    where: { symbol: 'AAPL', function: 'GLOBAL_QUOTE', status: 'ok' },
  });
  assert.equal(logs.length, 1);
});

test('runQuoteSchedulerTick: rate-limited Information payload records rate_limited status', async () => {
  await Security.create({ householdId: 1, symbol: 'AAPL', name: 'Apple', currency: 'USD', assetType: null });
  await seedNonQuoteFresh('AAPL');

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ Information: 'rate limit reached' }), { status: 200 })) as typeof fetch;

  const result = await runQuoteSchedulerTick(BASE_CONFIG);
  assert.equal(result.status, 'rate_limited');

  const logs = await ProviderJobLog.findAll({ where: { symbol: 'AAPL', status: 'rate_limited' } });
  assert.equal(logs.length, 1);

  const prices = await SecurityPrice.findAll({ where: { symbol: 'AAPL' } });
  assert.equal(prices.length, 0);
});

test('runQuoteSchedulerTick: OVERVIEW dispatch persists metadata for all matching Securities', async () => {
  const a = await Security.create({ householdId: 1, symbol: 'MSFT', name: 'Microsoft', currency: 'USD', assetType: null });
  const b = await Security.create({ householdId: 2, symbol: 'MSFT', name: 'Microsoft', currency: 'USD', assetType: null });
  // Make GLOBAL_QUOTE + DIVIDENDS fresh so picker chooses OVERVIEW.
  await ProviderJobLog.bulkCreate([
    {
      provider: 'alpha_vantage',
      function: 'GLOBAL_QUOTE',
      symbol: 'MSFT',
      status: 'ok',
      fetchedAt: new Date(),
    },
    {
      provider: 'alpha_vantage',
      function: 'DIVIDENDS',
      symbol: 'MSFT',
      status: 'ok',
      fetchedAt: new Date(),
    },
  ]);

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        Symbol: 'MSFT',
        Sector: 'Technology',
        Industry: 'Software',
        Country: 'USA',
        Exchange: 'NASDAQ',
        Description: 'Software company.',
        PERatio: '32.1',
      }),
      { status: 200 },
    )) as typeof fetch;

  const result = await runQuoteSchedulerTick(BASE_CONFIG);
  assert.equal(result.status, 'refreshed');
  assert.equal(result.function, 'OVERVIEW');
  assert.equal(result.symbol, 'MSFT');

  const aFresh = await Security.findByPk(a.id);
  const bFresh = await Security.findByPk(b.id);
  assert.ok(aFresh && bFresh);
  assert.equal(aFresh.metadata?.sector, 'Technology');
  assert.equal(bFresh.metadata?.sector, 'Technology');
  assert.ok(aFresh.metadataFetchedAt instanceof Date);
  assert.ok(bFresh.metadataFetchedAt instanceof Date);

  const log = await ProviderJobLog.findOne({
    where: { function: 'OVERVIEW', symbol: 'MSFT', status: 'ok' },
  });
  assert.ok(log);
});

test('runQuoteSchedulerTick: DIVIDENDS dispatch upserts per-Security dividend rows', async () => {
  const a = await Security.create({ householdId: 1, symbol: 'KO', name: 'Coca-Cola', currency: 'USD', assetType: null });
  const b = await Security.create({ householdId: 2, symbol: 'KO', name: 'Coca-Cola', currency: 'USD', assetType: null });
  // Freshness on GLOBAL_QUOTE + OVERVIEW so picker chooses DIVIDENDS.
  await ProviderJobLog.bulkCreate([
    {
      provider: 'alpha_vantage',
      function: 'GLOBAL_QUOTE',
      symbol: 'KO',
      status: 'ok',
      fetchedAt: new Date(),
    },
    {
      provider: 'alpha_vantage',
      function: 'OVERVIEW',
      symbol: 'KO',
      status: 'ok',
      fetchedAt: new Date(),
    },
  ]);

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        symbol: 'KO',
        data: [
          {
            ex_dividend_date: '2026-03-14',
            declaration_date: '2026-02-20',
            record_date: '2026-03-15',
            payment_date: '2026-04-01',
            amount: '0.485',
            currency: 'USD',
          },
        ],
      }),
      { status: 200 },
    )) as typeof fetch;

  const result = await runQuoteSchedulerTick(BASE_CONFIG);
  assert.equal(result.status, 'refreshed');
  assert.equal(result.function, 'DIVIDENDS');

  const aDivs = await SecurityDividend.findAll({ where: { securityId: a.id } });
  const bDivs = await SecurityDividend.findAll({ where: { securityId: b.id } });
  assert.equal(aDivs.length, 1);
  assert.equal(bDivs.length, 1);
  assert.equal(Number(aDivs[0].amount), 0.485);

  const log = await ProviderJobLog.findOne({
    where: { function: 'DIVIDENDS', symbol: 'KO', status: 'ok' },
  });
  assert.ok(log);
});
