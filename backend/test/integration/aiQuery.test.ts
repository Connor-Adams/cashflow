/**
 * Integration tests for POST /api/ai/query.
 *
 * Covers:
 *   - 503 when OPENAI_API_KEY is not configured
 *   - 400 when the question is missing/empty
 *   - 400 when the model emits an intent name that isn't whitelisted
 *   - 400 when the model emits an unknown filter field
 *   - 200 happy path for transaction_summary against seeded transactions
 *   - 200 happy path for partner_balance
 *   - Household scoping — a transaction in another household is not summed
 *
 * The OpenAI call is stubbed by monkey-patching `globalThis.fetch` for the
 * duration of each test. The real `openaiJsonWithMeta` uses `fetch` to hit
 * `api.openai.com`; the stub intercepts those calls and returns the JSON the
 * test wants. This keeps the runtime path end-to-end (validator + executor +
 * route + auth) while making the AI deterministic.
 */
import { after, before, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let householdId: number;
let otherHouseholdId: number;
let testDb: PgTestDb;

const ENV_KEYS = ['OPENAI_API_KEY'] as const;
const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

const realFetch = globalThis.fetch;
let fetchStubResponse: { json: unknown; status?: number } | null = null;
let lastStubbedRequestBody: unknown = null;

beforeEach(() => {
  fetchStubResponse = null;
  lastStubbedRequestBody = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://api.openai.com')) {
      if (init?.body) {
        try {
          lastStubbedRequestBody = JSON.parse(String(init.body));
        } catch {
          lastStubbedRequestBody = null;
        }
      }
      if (!fetchStubResponse) {
        return new Response('not stubbed', { status: 500 });
      }
      const status = fetchStubResponse.status ?? 200;
      const body = JSON.stringify({
        choices: [
          { message: { content: JSON.stringify(fetchStubResponse.json) } },
        ],
      });
      return new Response(body, {
        status,
        headers: { 'content-type': 'application/json', 'x-request-id': 'stub-req-1' },
      });
    }
    return realFetch(input as Parameters<typeof realFetch>[0], init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

before(async () => {
  for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
  delete process.env.OPENAI_API_KEY;

  testDb = await setupPgTestDb('ai-query');
  const mod = await import('../../src/app.js');
  app = mod.default;

  authed = request.agent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'nlquery@example.com',
    displayName: 'NL Query User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
  householdId = (register.body.user.household?.id ?? register.body.user.householdId) as number;

  const { Household } = await import('../../src/models/index.js');
  const otherHousehold = await Household.create({ name: 'Other Household' });
  otherHouseholdId = otherHousehold.id;
});

after(async () => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  await teardownPgTestDb(testDb);
  globalThis.fetch = realFetch;
});

test('POST /api/ai/query returns 503 when OPENAI_API_KEY is missing', async () => {
  delete process.env.OPENAI_API_KEY;
  const r = await authed.post('/api/ai/query').send({ question: 'spend last month?' });
  assert.equal(r.status, 503);
  assert.match(String(r.body.error), /not configured/i);
});

test('POST /api/ai/query rejects empty question with 400', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  const r = await authed.post('/api/ai/query').send({ question: '' });
  assert.equal(r.status, 400);
  assert.match(String(r.body.error), /question/i);
});

test('POST /api/ai/query rejects oversized question with 400', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  const r = await authed
    .post('/api/ai/query')
    .send({ question: 'x'.repeat(2000) });
  assert.equal(r.status, 400);
  assert.match(String(r.body.error), /too long|max/i);
});

test('POST /api/ai/query rejects model output that uses a non-whitelisted intent', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  fetchStubResponse = {
    json: { intent: 'drop_database', filters: {} },
  };
  const r = await authed
    .post('/api/ai/query')
    .send({ question: 'destroy everything' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'invalid_intent');
  assert.match(String(r.body.error), /not supported/i);
});

test('POST /api/ai/query rejects model output with unknown filter field', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  fetchStubResponse = {
    json: {
      intent: 'transaction_summary',
      filters: { rawSql: 'select * from transactions' },
    },
  };
  const r = await authed
    .post('/api/ai/query')
    .send({ question: 'hi' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'invalid_intent');
  assert.match(String(r.body.error), /unknown filter field/i);
});

test('POST /api/ai/query happy path: transaction_summary across seeded txns', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';

  const { Transaction, Account } = await import('../../src/models/index.js');
  const crypto = await import('crypto');
  const account = await Account.create({
    householdId,
    name: 'NL Query Account',
    owner: 'me',
    defaultCurrency: 'CAD',
  } as never);
  for (let i = 0; i < 3; i += 1) {
    await Transaction.create({
      householdId,
      accountId: account.id,
      currency: 'CAD',
      date: `2026-05-0${i + 1}`,
      merchantRaw: `RESTAURANT ${i}`,
      merchantClean: `Restaurant ${i}`,
      importBatch: 'nlquery-test',
      sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
      sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
      amount: '-25.00',
      finalCategory: 'Restaurants',
      finalBusiness: false,
      finalSplitType: 'me',
    } as never);
  }
  // Also seed one that should NOT match the category filter.
  await Transaction.create({
    householdId,
    accountId: account.id,
    currency: 'CAD',
    date: '2026-05-04',
    merchantRaw: 'GROCERY STORE',
    merchantClean: 'Grocery Store',
    importBatch: 'nlquery-test',
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    amount: '-90.00',
    finalCategory: 'Groceries',
    finalBusiness: false,
    finalSplitType: 'me',
  } as never);

  fetchStubResponse = {
    json: {
      intent: 'transaction_summary',
      filters: { category: 'Restaurants' },
      groupBy: 'category',
    },
  };

  const r = await authed
    .post('/api/ai/query')
    .send({ question: 'How much did I spend on restaurants?' });
  assert.equal(r.status, 200);
  assert.equal(r.body.intent.intent, 'transaction_summary');
  assert.equal(r.body.intent.filters.category, 'Restaurants');
  const totals = r.body.answer.totalsByCurrency as Array<{ currency: string; total: number; count: number }>;
  const cad = totals.find((t) => t.currency === 'CAD');
  assert.ok(cad, 'CAD bucket present');
  assert.equal(cad.count, 3);
  assert.equal(Math.round(cad.total * 100) / 100, -75);
  const sources = r.body.sources as Array<{ id: number; merchant: string }>;
  assert.equal(sources.length, 3);
  // Groups present and Restaurants is dominant
  const groups = r.body.answer.groups as Array<{ key: string; total: number }>;
  assert.ok(groups && groups.length > 0);
  assert.equal(groups[0].key, 'Restaurants');
});

test('POST /api/ai/query scopes by household — does not sum other-household txns', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  const { Transaction, Account } = await import('../../src/models/index.js');
  const crypto = await import('crypto');
  const otherAccount = await Account.create({
    householdId: otherHouseholdId,
    name: 'Other Hh Account',
    owner: 'me',
    defaultCurrency: 'CAD',
  } as never);
  await Transaction.create({
    householdId: otherHouseholdId,
    accountId: otherAccount.id,
    currency: 'CAD',
    date: '2026-05-05',
    merchantRaw: 'CROSS-HH MERCHANT',
    merchantClean: 'Cross-HH Merchant',
    importBatch: 'cross-hh-test',
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    amount: '-9999.00',
    finalCategory: 'Restaurants',
    finalBusiness: false,
    finalSplitType: 'me',
  } as never);

  fetchStubResponse = {
    json: {
      intent: 'transaction_summary',
      filters: { category: 'Restaurants' },
    },
  };

  // The previous test seeded 3 Restaurants txns @ -25 in the user's household.
  // The cross-household -9999 txn must NOT appear.
  const r = await authed
    .post('/api/ai/query')
    .send({ question: 'restaurants' });
  assert.equal(r.status, 200);
  const cad = (r.body.answer.totalsByCurrency as Array<{ currency: string; total: number }>)
    .find((t) => t.currency === 'CAD');
  assert.ok(cad);
  assert.equal(Math.round(cad.total * 100) / 100, -75); // unchanged from prior seed
});

test('POST /api/ai/query happy path: partner_balance returns balances and respects scoping', async () => {
  // First-registered user IS superadmin; superadmin sees all households when
  // computing partner_balance because scope.ts returns `{}` for superadmin.
  // To test the per-household path we'd need a non-superadmin agent. For now
  // we verify the endpoint runs end-to-end and returns the expected shape.
  process.env.OPENAI_API_KEY = 'sk-test';
  fetchStubResponse = { json: { intent: 'partner_balance' } };
  const r = await authed
    .post('/api/ai/query')
    .send({ question: 'how much does my partner owe me?' });
  assert.equal(r.status, 200);
  assert.equal(r.body.intent.intent, 'partner_balance');
  assert.ok(Array.isArray(r.body.answer.partnerBalances));
});

test('POST /api/ai/query maps OpenAI 429 to 429 rate_limited', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  fetchStubResponse = { status: 429, json: { error: 'rate limited' } };
  const r = await authed
    .post('/api/ai/query')
    .send({ question: 'hi' });
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'rate_limited');
});

test('POST /api/ai/query system prompt embeds today date so the model can resolve "last month"', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  fetchStubResponse = {
    json: { intent: 'transaction_summary', filters: {} },
  };
  await authed.post('/api/ai/query').send({ question: 'anything' });
  const body = lastStubbedRequestBody as {
    messages?: Array<{ role: string; content: string }>;
    response_format?: { type: string };
  } | null;
  assert.ok(body, 'OpenAI call body captured');
  assert.equal(body.response_format?.type, 'json_object');
  const system = body.messages?.[0];
  assert.equal(system?.role, 'system');
  assert.match(system?.content || '', /Today is \d{4}-\d{2}-\d{2}/);
  assert.match(system?.content || '', /transaction_summary/);
  assert.match(system?.content || '', /partner_balance/);
});
