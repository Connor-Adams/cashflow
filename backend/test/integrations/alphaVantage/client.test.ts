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

const originalFetch = globalThis.fetch;

before(async () => {
  process.env.ALPHA_VANTAGE_API_KEY = 'test-key';
  process.env.NODE_ENV = 'test';

  const clientModule = await import('../../../src/integrations/alphaVantage/client.js');
  AlphaVantageError = clientModule.AlphaVantageError;
  fetchGlobalQuote = clientModule.fetchGlobalQuote;
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
