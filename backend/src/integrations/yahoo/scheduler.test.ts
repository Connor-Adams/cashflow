/**
 * Unit tests for the quote scheduler's dispatch + persist path. Migrated
 * (not `sync()`ed) DB so the real unique indexes on `security_prices` apply.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-yahoo-scheduler-unit.sqlite');

let models: typeof import('../../models');
let scheduler: typeof import('./scheduler');

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

  models = await import('../../models');
  scheduler = await import('./scheduler');
});

after(async () => {
  scheduler.__setYahooFetchersForTests();
  await models.sequelize.close();
});

beforeEach(async () => {
  await models.SecurityPrice.destroy({ where: {} });
  await models.ProviderJobLog.destroy({ where: {} });
  await models.Security.destroy({ where: {} });
});

const TICK = { enabled: true, minAgeHours: 1 };
const PRICED_AT = new Date('2026-10-16T20:00:00Z');

function quoteStub(resolvesOn: string, price = 12.5) {
  const tried: string[] = [];
  scheduler.__setYahooFetchersForTests({
    fetchQuote: async (symbol: string) => {
      tried.push(symbol);
      return symbol === resolvesOn
        ? { price, pricedAt: PRICED_AT, currency: 'CAD', previousClose: null }
        : null;
    },
    fetchOverview: async () => null,
    fetchDividends: async () => [],
  });
  return tried;
}

async function makeSecurity(symbol: string) {
  return models.Security.create({
    householdId: 1, symbol, name: symbol, assetType: 'EQUITY', currency: 'CAD',
  });
}

test('a quote resolved on an alternate suffix is persisted to the security', async () => {
  // Regression: persist looked securities up by the resolved symbol
  // (SMALL.V), which never equals any security's primary (SMALL.TO), so the
  // tick logged ok and wrote nothing.
  const sec = await makeSecurity('SMALL');
  const tried = quoteStub('SMALL.V');

  const r = await scheduler.runQuoteSchedulerTick(TICK);
  assert.equal(r.status, 'refreshed');
  assert.equal(r.symbol, 'SMALL.V');
  assert.deepEqual(tried, ['SMALL.TO', 'SMALL.V']);

  const prices = await models.SecurityPrice.findAll({ where: { securityId: sec.id } });
  assert.equal(prices.length, 1);
  assert.equal(Number(prices[0].price), 12.5);
  assert.equal(prices[0].symbol, 'SMALL');
});

test('re-quoting an unchanged pricedAt (market closed) updates instead of failing', async () => {
  const sec = await makeSecurity('XEQT');
  quoteStub('XEQT.TO', 30);
  assert.equal((await scheduler.runQuoteSchedulerTick(TICK)).status, 'refreshed');

  // Clear the log so the picker selects XEQT again; Yahoo returns the same
  // regularMarketTime because the market has not reopened.
  await models.ProviderJobLog.destroy({ where: {} });
  quoteStub('XEQT.TO', 31);
  const r = await scheduler.runQuoteSchedulerTick(TICK);
  assert.equal(r.status, 'refreshed', r.error);

  const prices = await models.SecurityPrice.findAll({ where: { securityId: sec.id } });
  assert.equal(prices.length, 1);
  assert.equal(Number(prices[0].price), 31);
});
