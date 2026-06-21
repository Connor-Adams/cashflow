/**
 * Integration tests for POST /api/simplefin/connect (issue #790), AC 2–7.
 * Postgres-backed; stubs globalThis.fetch for the claim-URL exchange and the
 * account-discovery call. Asserts row state, encryption (ciphertext != access
 * URL), status codes, exact error copy, upsert-not-duplicate, and account
 * mapping — and that zero Transaction rows are written.
 */
import { after, before, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

const CLAIM_URL = 'https://beta-bridge.simplefin.org/simplefin/claim/tok-abc';
const SETUP_TOKEN = Buffer.from(CLAIM_URL, 'utf8').toString('base64');
const ACCESS_URL = 'https://u53r:p4ss@beta-bridge.simplefin.org/simplefin';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let models: typeof import('../../src/models/index.js');
let testDb: PgTestDb;
let householdId: number;
let userId: number;
let originalFetch: typeof globalThis.fetch;

before(async () => {
  process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY =
    '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  testDb = await setupPgTestDb('simplefin-connect');
  models = await import('../../src/models/index.js');
  const enc = await import('../../src/util/symmetricEncryption.js');
  enc.__resetKeyCacheForTests();
  app = (await import('../../src/app.js')).default;
  authed = testAgent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'simplefin@example.com',
    displayName: 'SimpleFIN User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
  const hh = await models.Household.findOne();
  assert.ok(hh);
  householdId = hh.id;
  const user = await models.User.findOne();
  assert.ok(user);
  userId = user.id;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await models.UserSimplefinIntegration.destroy({ where: {} });
});

/** Stub fetch: claim URL → access URL text, discovery → given accounts JSON. */
function stubFetch(opts: {
  claim?: () => Response;
  accounts?: unknown[];
} = {}) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === CLAIM_URL && init?.method === 'POST') {
      if (opts.claim) return opts.claim();
      return new Response(ACCESS_URL, { status: 200 });
    }
    if (url.includes('/accounts')) {
      return new Response(JSON.stringify({ accounts: opts.accounts ?? [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
}

test('AC2: valid token decodes, claims, and persists one encrypted row', async () => {
  stubFetch({ accounts: [] });
  const res = await authed.post('/api/simplefin/connect').send({ setupToken: SETUP_TOKEN });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 'connected');

  const rows = await models.UserSimplefinIntegration.findAll({ where: { userId } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'connected');
  assert.ok(rows[0].accessUrlEncrypted, 'access_url_encrypted set');
  assert.notEqual(rows[0].accessUrlEncrypted, ACCESS_URL, 'must be encrypted, not plaintext');
  // It really decrypts back to the access URL.
  const enc = await import('../../src/util/symmetricEncryption.js');
  assert.equal(enc.decryptSecret(rows[0].accessUrlEncrypted), ACCESS_URL);
});

test('AC3: missing/empty setupToken returns 400 invalid_setup_token, no row', async () => {
  const missing = await authed.post('/api/simplefin/connect').send({});
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, 'invalid_setup_token');
  const empty = await authed.post('/api/simplefin/connect').send({ setupToken: '   ' });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error, 'invalid_setup_token');
  assert.equal(await models.UserSimplefinIntegration.count(), 0);
});

test('AC4: token decoding to a non-https URL returns 400 with documented message', async () => {
  const badToken = Buffer.from('http://insecure.example.com/claim', 'utf8').toString('base64');
  const res = await authed.post('/api/simplefin/connect').send({ setupToken: badToken });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_setup_token');
  assert.equal(
    res.body.message,
    "That setup token isn't valid. Paste a fresh token from SimpleFIN Bridge.",
  );
  assert.equal(await models.UserSimplefinIntegration.count(), 0);
});

test('AC5: claim exchange non-2xx returns 502 claim_exchange_failed with copy, no row', async () => {
  stubFetch({ claim: () => new Response('expired', { status: 403 }) });
  const res = await authed.post('/api/simplefin/connect').send({ setupToken: SETUP_TOKEN });
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'claim_exchange_failed');
  assert.equal(
    res.body.message,
    "We couldn't connect your bank. Check that you pasted a fresh setup token and try again.",
  );
  assert.equal(await models.UserSimplefinIntegration.count(), 0);
});

test('AC5: claim returning empty access URL returns 502, no row', async () => {
  stubFetch({ claim: () => new Response('', { status: 200 }) });
  const res = await authed.post('/api/simplefin/connect').send({ setupToken: SETUP_TOKEN });
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'claim_exchange_failed');
  assert.equal(await models.UserSimplefinIntegration.count(), 0);
});

test('AC6: connecting twice upserts (no duplicate row)', async () => {
  stubFetch({ accounts: [] });
  const first = await authed.post('/api/simplefin/connect').send({ setupToken: SETUP_TOKEN });
  assert.equal(first.status, 200);
  // Second access URL differs; the stored row must be REPLACED, not duplicated.
  const secondAccess = 'https://newuser:newpass@beta-bridge.simplefin.org/simplefin';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === CLAIM_URL && init?.method === 'POST') {
      return new Response(secondAccess, { status: 200 });
    }
    if (url.includes('/accounts')) {
      return new Response(JSON.stringify({ accounts: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('nf', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  const second = await authed.post('/api/simplefin/connect').send({ setupToken: SETUP_TOKEN });
  assert.equal(second.status, 200);

  const rows = await models.UserSimplefinIntegration.findAll({ where: { userId } });
  assert.equal(rows.length, 1, 'still exactly one row');
  const enc = await import('../../src/util/symmetricEncryption.js');
  assert.equal(enc.decryptSecret(rows[0].accessUrlEncrypted), secondAccess);
});

// Issue #814: encryption key missing/invalid → 503 encryption_unconfigured,
// returned BEFORE the setup token is exchanged (token stays valid for retry).
const VALID_KEY =
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

async function withEncryptionKey<T>(
  value: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const enc = await import('../../src/util/symmetricEncryption.js');
  const original = process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY;
  if (value === undefined) delete process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY;
  else process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY = value;
  enc.__resetKeyCacheForTests();
  try {
    return await fn();
  } finally {
    process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY = original;
    enc.__resetKeyCacheForTests();
  }
}

test('AC1/AC2 (#814): unset key → 503 encryption_unconfigured, token NOT exchanged, no row', async () => {
  let claimCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === CLAIM_URL && init?.method === 'POST') {
      claimCalls += 1;
      return new Response(ACCESS_URL, { status: 200 });
    }
    return new Response('nf', { status: 404 });
  }) as unknown as typeof globalThis.fetch;

  const res = await withEncryptionKey(undefined, () =>
    authed.post('/api/simplefin/connect').send({ setupToken: SETUP_TOKEN }),
  );

  assert.equal(res.status, 503, JSON.stringify(res.body));
  assert.equal(res.body.error, 'encryption_unconfigured');
  assert.notEqual(res.body.error, 'storage_failed');
  assert.notEqual(res.body.error, 'invalid_setup_token');
  assert.match(res.body.message, /server configuration issue/i);
  assert.match(res.body.message, /your token is still valid/i);
  assert.equal(claimCalls, 0, 'claimAccessUrl must NOT be called — token not consumed');
  assert.equal(await models.UserSimplefinIntegration.count(), 0);
});

test('AC3 (#814): key present but invalid (wrong length) → 503 encryption_unconfigured, no exchange', async () => {
  let claimCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === CLAIM_URL && init?.method === 'POST') {
      claimCalls += 1;
      return new Response(ACCESS_URL, { status: 200 });
    }
    return new Response('nf', { status: 404 });
  }) as unknown as typeof globalThis.fetch;

  const res = await withEncryptionKey('deadbeef', () =>
    authed.post('/api/simplefin/connect').send({ setupToken: SETUP_TOKEN }),
  );

  assert.equal(res.status, 503, JSON.stringify(res.body));
  assert.equal(res.body.error, 'encryption_unconfigured');
  assert.equal(claimCalls, 0, 'invalid key must not exchange the token');
  assert.equal(await models.UserSimplefinIntegration.count(), 0);
});

test('AC4 (#814): with a valid key the connect path still succeeds end-to-end', async () => {
  stubFetch({ accounts: [] });
  const res = await withEncryptionKey(VALID_KEY, () =>
    authed.post('/api/simplefin/connect').send({ setupToken: SETUP_TOKEN }),
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 'connected');
  const rows = await models.UserSimplefinIntegration.findAll({ where: { userId } });
  assert.equal(rows.length, 1);
});

test('AC7: discovery maps accounts, reports unlinked, writes zero transactions', async () => {
  await models.Account.create({
    name: 'My Checking',
    owner: 'me',
    householdId,
    bankAccountNumber: '****1234',
  } as never);
  const txnBefore = await models.Transaction.count();

  stubFetch({
    accounts: [
      { id: 'ACT-1', name: 'Checking', 'account-number': 'XXXX1234' },
      { id: 'ACT-2', name: 'Brokerage', 'account-number': '9999' },
    ],
  });
  const res = await authed.post('/api/simplefin/connect').send({ setupToken: SETUP_TOKEN });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.accountsFound, 2);
  assert.equal(res.body.accountsLinked, 1);
  assert.deepEqual(res.body.unlinkedAccounts, [{ simplefinId: 'ACT-2', name: 'Brokerage' }]);

  const txnAfter = await models.Transaction.count();
  assert.equal(txnAfter, txnBefore, 'no Transaction rows created by connect');
});
