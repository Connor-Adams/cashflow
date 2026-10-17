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

let models: typeof import('../models');
let backfill: typeof import('./backfill');
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

  models = await import('../models');
  sequelize = models.sequelize;
  backfill = await import('./backfill');
});

after(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  await models.SecurityDailyPrice.destroy({ where: {}, truncate: true });
  await models.SecurityDividend.destroy({ where: {}, truncate: true });
  await models.Security.destroy({ where: {}, truncate: true });
  await models.ProviderJobLog.destroy({ where: {}, truncate: true });
  await models.HoldingSnapshot.destroy({ where: {}, truncate: true });
  await models.Account.destroy({ where: {}, truncate: true });
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
  await backfill.__drainForTests();
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
  await backfill.__drainForTests();

  assert.equal(observedSymbol, 'XEQT.TO', 'Yahoo client should be called with the .TO-suffixed symbol');
  const okLog = await models.ProviderJobLog.findOne({
    where: { function: 'DAILY_HISTORY', symbol: 'XEQT.TO', status: 'ok' },
  });
  assert.ok(okLog, 'job log should record the Yahoo-mapped symbol');
});

test('ensureDailyPrices falls back to .V when .TO returns no data (TSXV)', async () => {
  const sec = await models.Security.create({
    householdId: 1, symbol: 'PLUR', name: 'Plurilock Security Inc.', assetType: 'equity', currency: 'CAD',
  });
  const observedSymbols: string[] = [];
  backfill.__setYahooFetchers({
    fetchQuote: async () => null,
    fetchDailyHistory: async (symbol) => {
      observedSymbols.push(symbol);
      if (symbol === 'PLUR.TO') return null;
      return [{ date: '2026-05-21', open: 0.2, high: 0.21, low: 0.19, close: 0.2, adjClose: 0.2, volume: 1000 }];
    },
    fetchDividends: async () => [],
    fetchOverview: async () => null,
  });

  await backfill.ensureDailyPrices(sec.id);
  await backfill.__drainForTests();

  assert.deepEqual(observedSymbols, ['PLUR.TO', 'PLUR.V']);
  const notFound = await models.ProviderJobLog.findOne({
    where: { function: 'DAILY_HISTORY', symbol: 'PLUR.TO', status: 'not_found' },
  });
  assert.ok(notFound, '.TO attempt should be recorded as not_found');
  const ok = await models.ProviderJobLog.findOne({
    where: { function: 'DAILY_HISTORY', symbol: 'PLUR.V', status: 'ok' },
  });
  assert.ok(ok, '.V fallback should be recorded as ok');
});

test('ensureDailyPrices uses BTC-CAD for cryptocurrency assetType', async () => {
  const sec = await models.Security.create({
    householdId: 1, symbol: 'BTC', name: 'Bitcoin', assetType: 'cryptocurrency', currency: 'CAD',
  });
  let observedSymbol: string | null = null;
  backfill.__setYahooFetchers({
    fetchQuote: async () => null,
    fetchDailyHistory: async (symbol) => {
      observedSymbol = symbol;
      return [{ date: '2026-05-21', open: 80000, high: 82000, low: 79000, close: 81000, adjClose: 81000, volume: 0 }];
    },
    fetchDividends: async () => [],
    fetchOverview: async () => null,
  });

  await backfill.ensureDailyPrices(sec.id);
  await backfill.__drainForTests();

  assert.equal(observedSymbol, 'BTC-CAD');
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
  await backfill.__drainForTests();
  assert.equal(calls, 1, 'Yahoo called exactly once for concurrent requests');
  assert.ok(['never', 'in_progress'].includes(a.status));
});

type OverviewFixture = NonNullable<
  Awaited<ReturnType<typeof import('../integrations/yahoo/client').fetchOverview>>
>;

function makeOverview(partial: Partial<OverviewFixture>): OverviewFixture {
  const base: OverviewFixture = {
    sector: null,
    industry: null,
    country: null,
    exchange: null,
    description: null,
    regularMarketPrice: null,
    previousClose: null,
    marketCap: null,
    trailingPE: null,
    forwardPE: null,
    trailingEps: null,
    forwardEps: null,
    beta: null,
    dayLow: null,
    dayHigh: null,
    fiftyTwoWeekLow: null,
    fiftyTwoWeekHigh: null,
    fiftyDayAverage: null,
    twoHundredDayAverage: null,
    volume: null,
    averageVolume: null,
    averageVolume10days: null,
    sharesOutstanding: null,
    priceToBook: null,
    bookValue: null,
    dividendRate: null,
    dividendYield: null,
    fiveYearAvgDividendYield: null,
    payoutRatio: null,
    exDividendDate: null,
    totalRevenue: null,
    revenuePerShare: null,
    grossMargins: null,
    operatingMargins: null,
    profitMargins: null,
    ebitdaMargins: null,
    returnOnAssets: null,
    returnOnEquity: null,
    totalCash: null,
    totalDebt: null,
    debtToEquity: null,
    freeCashflow: null,
    operatingCashflow: null,
    targetMeanPrice: null,
    targetHighPrice: null,
    targetLowPrice: null,
    recommendationMean: null,
    recommendationKey: null,
    numberOfAnalystOpinions: null,
    financialCurrency: null,
    circulatingSupply: null,
    volume24Hr: null,
    cryptoStartDate: null,
    fromCurrency: null,
    fundFamily: null,
    fundCategory: null,
    fundLegalType: null,
    fundExpenseRatio: null,
    fundTotalAssets: null,
    fundYield: null,
    topHoldings: null,
    sectorWeightings: null,
    bondPosition: null,
    stockPosition: null,
    cashPosition: null,
    trailingReturn1y: null,
    trailingReturn3y: null,
    trailingReturn5y: null,
    trailingReturn10y: null,
    trailingReturnYtd: null,
    nextEarningsDate: null,
    nextEarningsIsEstimate: null,
    earningsEpsAvg: null,
    earningsEpsLow: null,
    earningsEpsHigh: null,
    earningsRevenueAvg: null,
    earningsRevenueLow: null,
    earningsRevenueHigh: null,
    earningsHistory: null,
    recommendationTrend: null,
    upgradeDowngradeHistory: null,
    raw: {},
  };
  return { ...base, ...partial };
}

test('ensureOverview persists metadata + logs ok', async () => {
  const sec = await models.Security.create({
    householdId: 1, symbol: 'AAPL', name: 'Apple', assetType: 'EQUITY', currency: 'USD',
  });
  backfill.__setYahooFetchers({
    fetchQuote: async () => null,
    fetchDailyHistory: async () => [],
    fetchDividends: async () => [],
    fetchOverview: async () => makeOverview({
      sector: 'Technology',
      industry: 'Consumer Electronics',
      country: 'United States',
      exchange: 'NMS',
      description: 'Designs phones.',
      marketCap: 3_000_000_000_000,
      trailingPE: 32.5,
      dividendYield: 0.005,
      raw: { symbol: 'AAPL' },
    }),
  });

  const first = await backfill.ensureOverview(sec.id);
  assert.equal(first.status, 'never');
  await backfill.__drainForTests();

  const refreshed = await models.Security.findByPk(sec.id);
  assert.ok(refreshed);
  assert.equal(refreshed.metadata?.sector, 'Technology');
  assert.equal(refreshed.metadata?.marketCap, 3_000_000_000_000);
  assert.equal(refreshed.metadata?.trailingPE, 32.5);
  assert.equal(refreshed.metadata?.dividendYield, 0.005);
  assert.ok(refreshed.metadataFetchedAt instanceof Date);

  const okLog = await models.ProviderJobLog.findOne({
    where: { function: 'OVERVIEW', symbol: 'AAPL', status: 'ok' },
  });
  assert.ok(okLog, 'a provider_job_log row should be recorded for OVERVIEW');

  const second = await backfill.ensureOverview(sec.id);
  assert.equal(second.status, 'fresh');
});

test('ensureOverview skips Yahoo for cash-placeholder symbols', async () => {
  const sec = await models.Security.create({
    householdId: 1, symbol: 'USD', name: 'US Cash', assetType: 'CASH', currency: 'USD',
  });
  let called = false;
  backfill.__setYahooFetchers({
    fetchQuote: async () => null,
    fetchDailyHistory: async () => [],
    fetchDividends: async () => [],
    fetchOverview: async () => {
      called = true;
      return null;
    },
  });

  const status = await backfill.ensureOverview(sec.id);
  await backfill.__drainForTests();

  assert.equal(status.status, 'fresh', 'cash positions should short-circuit, not poll Yahoo');
  assert.equal(called, false, 'Yahoo fetcher must not be invoked for cash placeholders');

  const logs = await models.ProviderJobLog.findAll({
    where: { function: 'OVERVIEW' },
  });
  assert.equal(logs.length, 0, 'no provider_job_log row should be recorded');
});

test('ensureDividends rate-limit response is recorded as rate_limited', async () => {
  const sec = await models.Security.create({
    householdId: 1, symbol: 'DVT', name: 'Div Test', assetType: 'EQUITY', currency: 'USD',
  });
  const { YahooFinanceError } = await import('../integrations/yahoo/client');
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
  await backfill.__drainForTests();

  const log = await models.ProviderJobLog.findOne({
    where: { function: 'DIVIDENDS', symbol: 'DVT' },
  });
  assert.ok(log);
  assert.equal(log.status, 'rate_limited');
});

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function bar(date: string, close: number) {
  return { date, open: close, high: close, low: close, close, adjClose: close, volume: 100 };
}

test('a compact refresh overlapping stored bars updates them instead of failing', async () => {
  // Regression: the model declared no unique key, so upsert targeted
  // ON CONFLICT (id) and the (security_id, date) unique index rejected every
  // overlapping bar with "Validation error" — history froze after the first
  // full backfill.
  const sec = await models.Security.create({
    householdId: 1, symbol: 'OVL', name: 'Overlap', assetType: 'EQUITY', currency: 'USD',
  });
  await models.SecurityDailyPrice.create({
    securityId: sec.id, date: isoDaysAgo(5), open: '1', high: '1', low: '1',
    close: '1', adjClose: '1', volume: 1, source: 'yahoo', fetchedAt: new Date(),
  });
  backfill.__setYahooFetchers({
    fetchQuote: async () => null,
    fetchDailyHistory: async () => [bar(isoDaysAgo(5), 9), bar(isoDaysAgo(1), 10)],
    fetchDividends: async () => [],
    fetchOverview: async () => null,
  });

  const status = await backfill.ensureDailyPrices(sec.id);
  assert.equal(status.status, 'stale');
  await backfill.__drainForTests();

  const rows = await models.SecurityDailyPrice.findAll({
    where: { securityId: sec.id },
    order: [['date', 'ASC']],
  });
  assert.deepEqual(rows.map((r) => [r.date, Number(r.close)]), [
    [isoDaysAgo(5), 9],
    [isoDaysAgo(1), 10],
  ]);
  const log = await models.ProviderJobLog.findOne({ where: { function: 'DAILY_HISTORY' } });
  assert.equal(log?.status, 'ok');
});

async function makeHeld(symbol: string, currency: string, quantity = '10') {
  const sec = await models.Security.create({
    householdId: 1, symbol, name: symbol, assetType: 'EQUITY', currency,
  });
  const household = await models.Household.create({ name: `Household ${symbol}` });
  const account = await models.Account.create({
    householdId: household.id, name: `Brokerage ${symbol}`, owner: 'shared',
    accountType: 'investment', currency,
  });
  await models.HoldingSnapshot.create({
    accountId: account.id, householdId: household.id, securityId: sec.id,
    statementDate: isoDaysAgo(10), quantity, price: null, marketValue: null,
    costBasis: null, unrealizedGainLoss: null, currency,
    sourceReference: 'test', sourceRowFingerprint: `test:${symbol}`, importBatch: 'test',
  });
  return sec;
}

test('refreshHeldDailyPrices backfills every held security with stale history', async () => {
  const never = await makeHeld('NEW', 'USD');
  const stale = await makeHeld('OLD', 'USD');
  await models.SecurityDailyPrice.create({
    securityId: stale.id, date: isoDaysAgo(30), open: '1', high: '1', low: '1',
    close: '1', adjClose: '1', volume: 1, source: 'yahoo', fetchedAt: new Date(),
  });
  await models.Security.create({
    householdId: 1, symbol: 'NOTHELD', name: 'Not held', assetType: 'EQUITY', currency: 'USD',
  });

  const fetched: string[] = [];
  backfill.__setYahooFetchers({
    fetchQuote: async () => null,
    fetchDailyHistory: async (symbol) => {
      fetched.push(symbol);
      return [bar(isoDaysAgo(1), 5)];
    },
    fetchDividends: async () => [],
    fetchOverview: async () => null,
  });

  const summary = await backfill.refreshHeldDailyPrices();
  assert.deepEqual(fetched.sort(), ['NEW', 'OLD']);
  assert.equal(summary.held, 2);
  assert.equal(summary.attempted, 2);
  for (const sec of [never, stale]) {
    const latest = await models.SecurityDailyPrice.max('date', { where: { securityId: sec.id } });
    assert.equal(latest, isoDaysAgo(1));
  }
});

test('refreshHeldDailyPrices skips fresh history and recently attempted symbols', async () => {
  const fresh = await makeHeld('FRESH', 'USD');
  await models.SecurityDailyPrice.create({
    securityId: fresh.id, date: isoDaysAgo(1), open: '1', high: '1', low: '1',
    close: '1', adjClose: '1', volume: 1, source: 'yahoo', fetchedAt: new Date(),
  });
  // Delisted: every suffix came back not_found an hour ago.
  await makeHeld('DEAD', 'CAD');
  for (const symbol of ['DEAD.TO', 'DEAD.V', 'DEAD.CN']) {
    await models.ProviderJobLog.create({
      provider: 'yahoo', function: 'DAILY_HISTORY', symbol, status: 'not_found',
      httpStatus: null, errorMessage: null, fetchedAt: new Date(Date.now() - 3600_000),
    });
  }
  await makeHeld('SOLD', 'USD', '0');

  const fetched: string[] = [];
  backfill.__setYahooFetchers({
    fetchQuote: async () => null,
    fetchDailyHistory: async (symbol) => {
      fetched.push(symbol);
      return null;
    },
    fetchDividends: async () => [],
    fetchOverview: async () => null,
  });

  const summary = await backfill.refreshHeldDailyPrices();
  assert.deepEqual(fetched, []);
  assert.equal(summary.held, 2);
  assert.equal(summary.skippedFresh, 1);
  assert.equal(summary.skippedBackoff, 1);
  assert.equal(summary.attempted, 0);
});

test('refreshHeldDailyPrices retries a failed symbol once the backoff has elapsed', async () => {
  await makeHeld('DEAD', 'CAD');
  await models.ProviderJobLog.create({
    provider: 'yahoo', function: 'DAILY_HISTORY', symbol: 'DEAD.CN', status: 'not_found',
    httpStatus: null, errorMessage: null, fetchedAt: new Date(Date.now() - 2 * 86400_000),
  });
  const fetched: string[] = [];
  backfill.__setYahooFetchers({
    fetchQuote: async () => null,
    fetchDailyHistory: async (symbol) => {
      fetched.push(symbol);
      return null;
    },
    fetchDividends: async () => [],
    fetchOverview: async () => null,
  });

  const summary = await backfill.refreshHeldDailyPrices();
  assert.deepEqual(fetched, ['DEAD.TO', 'DEAD.V', 'DEAD.CN']);
  assert.equal(summary.attempted, 1);
});

test('a stale dividend refresh re-upserting a stored ex-date updates it instead of failing', async () => {
  // Same "Validation error" as daily bars: without the model declaring the
  // (security_id, ex_dividend_date) index, upsert targeted ON CONFLICT (id).
  const sec = await models.Security.create({
    householdId: 1, symbol: 'DIVR', name: 'Div Refresh', assetType: 'EQUITY', currency: 'USD',
  });
  const exDate = isoDaysAgo(40);
  await models.SecurityDividend.create({
    securityId: sec.id, exDividendDate: exDate, declarationDate: null, recordDate: null,
    paymentDate: null, amount: '0.10', currency: 'USD', source: 'yahoo',
    fetchedAt: new Date(Date.now() - 31 * 86400_000),
  });
  backfill.__setYahooFetchers({
    fetchQuote: async () => null,
    fetchDailyHistory: async () => null,
    fetchDividends: async () => [{
      exDividendDate: exDate, declarationDate: null, recordDate: null,
      paymentDate: null, amount: 0.12, currency: 'USD',
    }],
    fetchOverview: async () => null,
  });

  const status = await backfill.ensureDividends(sec.id);
  assert.equal(status.status, 'stale');
  await backfill.__drainForTests();

  const rows = await models.SecurityDividend.findAll({ where: { securityId: sec.id } });
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].amount), 0.12);
  const log = await models.ProviderJobLog.findOne({ where: { function: 'DIVIDENDS' } });
  assert.equal(log?.status, 'ok');
});
