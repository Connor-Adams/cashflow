/**
 * Pure HTTP tests for the Alpha Vantage client. No DB, no models.
 *
 * The client throws AlphaVantageError on HTTP failures and on Alpha
 * Vantage's free-tier "200 OK with a Note/Information field" rate-limit
 * payloads.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

let AlphaVantageError: typeof import('../../../src/integrations/alphaVantage/client.js').AlphaVantageError;
let fetchGlobalQuote: typeof import('../../../src/integrations/alphaVantage/client.js').fetchGlobalQuote;
let fetchDailyAdjusted: typeof import('../../../src/integrations/alphaVantage/client.js').fetchDailyAdjusted;
let fetchDividends: typeof import('../../../src/integrations/alphaVantage/client.js').fetchDividends;
let fetchOverview: typeof import('../../../src/integrations/alphaVantage/client.js').fetchOverview;

const originalFetch = globalThis.fetch;

before(async () => {
  process.env.ALPHA_VANTAGE_API_KEY = 'test-key';
  process.env.NODE_ENV = 'test';

  const clientModule = await import('../../../src/integrations/alphaVantage/client.js');
  AlphaVantageError = clientModule.AlphaVantageError;
  fetchGlobalQuote = clientModule.fetchGlobalQuote;
  fetchDailyAdjusted = clientModule.fetchDailyAdjusted;
  fetchDividends = clientModule.fetchDividends;
  fetchOverview = clientModule.fetchOverview;
});

after(() => {
  globalThis.fetch = originalFetch;
});

test('fetchGlobalQuote: parses Global Quote payload', async () => {
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

  const result = await fetchGlobalQuote('AAPL');
  assert.ok(result !== null);
  assert.equal(result.price, 184.53);
  assert.equal(result.pricedAt.toISOString(), '2026-05-23T21:00:00.000Z');
});

test('fetchGlobalQuote: returns null when price field missing', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ 'Global Quote': {} }), { status: 200 })) as typeof fetch;
  const result = await fetchGlobalQuote('AAPL');
  assert.equal(result, null);
});

test('fetchGlobalQuote: throws AlphaVantageError on HTTP failure', async () => {
  globalThis.fetch = (async () =>
    new Response('Server Error', { status: 502 })) as typeof fetch;
  await assert.rejects(
    () => fetchGlobalQuote('AAPL'),
    (err: unknown) =>
      err instanceof AlphaVantageError &&
      err.httpStatus === 502 &&
      /HTTP 502/.test(err.message),
  );
});

test('fetchGlobalQuote: throws AlphaVantageError with providerNote on Information payload', async () => {
  const note = 'Our standard API rate limit is 25 requests per day.';
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ Information: note }), { status: 200 })) as typeof fetch;
  await assert.rejects(
    () => fetchGlobalQuote('AAPL'),
    (err: unknown) =>
      err instanceof AlphaVantageError &&
      err.providerNote === note &&
      err.message === note,
  );
});

test('fetchGlobalQuote: throws AlphaVantageError with providerNote on Note payload', async () => {
  const note = 'Thank you for using Alpha Vantage! Please subscribe...';
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ Note: note }), { status: 200 })) as typeof fetch;
  await assert.rejects(
    () => fetchGlobalQuote('AAPL'),
    (err: unknown) =>
      err instanceof AlphaVantageError && err.providerNote === note,
  );
});

test('fetchDailyAdjusted: parses Time Series (Daily) and returns ascending bars', async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        'Time Series (Daily)': {
          '2026-05-22': { '1. open': '180', '2. high': '185', '3. low': '178', '4. close': '184', '5. adjusted close': '183.5', '6. volume': '12345' },
          '2026-05-21': { '1. open': '178', '2. high': '181', '3. low': '177', '4. close': '180', '5. adjusted close': '179.5', '6. volume': '11111' },
        },
      }),
      { status: 200 },
    )) as typeof fetch;
  const bars = await fetchDailyAdjusted('AAPL', 'compact');
  assert.ok(bars);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].date, '2026-05-21');
  assert.equal(bars[1].date, '2026-05-22');
  assert.equal(bars[1].close, 184);
  assert.equal(bars[1].adjClose, 183.5);
});

test('fetchDailyAdjusted: returns null when series missing from payload', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
  const bars = await fetchDailyAdjusted('XYZ', 'compact');
  assert.equal(bars, null);
});

test('fetchDividends: parses data array and sorts ascending by ex_dividend_date', async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          { ex_dividend_date: '2026-03-14', amount: '0.485', currency: 'USD' },
          { ex_dividend_date: '2025-12-15', amount: '0.46', currency: 'USD' },
        ],
      }),
      { status: 200 },
    )) as typeof fetch;
  const events = await fetchDividends('KO');
  assert.ok(events);
  assert.equal(events.length, 2);
  assert.equal(events[0].exDividendDate, '2025-12-15');
  assert.equal(events[1].amount, 0.485);
});

test('fetchDividends: returns null when data missing', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
  const events = await fetchDividends('XYZ');
  assert.equal(events, null);
});

test('fetchOverview: parses standard payload and preserves raw', async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        Symbol: 'AAPL',
        Sector: 'Technology',
        Industry: 'Consumer Electronics',
        Country: 'USA',
        Exchange: 'NASDAQ',
        Description: 'Designs phones.',
        PERatio: '30.5',
      }),
      { status: 200 },
    )) as typeof fetch;
  const overview = await fetchOverview('AAPL');
  assert.ok(overview);
  assert.equal(overview.sector, 'Technology');
  assert.equal(overview.exchange, 'NASDAQ');
  assert.equal(overview.raw.PERatio, '30.5');
});

test('fetchOverview: returns null when Symbol field absent', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
  const overview = await fetchOverview('XYZ');
  assert.equal(overview, null);
});

test('fetchOverview: filters "None" sentinel strings to null', async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ Symbol: 'X', Sector: 'None', Industry: '', Country: 'USA' }),
      { status: 200 },
    )) as typeof fetch;
  const overview = await fetchOverview('X');
  assert.ok(overview);
  assert.equal(overview.sector, null);
  assert.equal(overview.industry, null);
  assert.equal(overview.country, 'USA');
});
