/**
 * Integration tests for the explicit SimpleFIN account mapping (issue #813).
 * Postgres-backed; stubs globalThis.fetch for the connect handshake and the
 * `/accounts?balances-only=1` discovery call. Covers AC 1,2,3,4,5,7,9.
 */
import { after, before, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

const CLAIM_URL = 'https://beta-bridge.simplefin.org/simplefin/claim/tok-links';
const SETUP_TOKEN = Buffer.from(CLAIM_URL, 'utf8').toString('base64');
const ACCESS_URL = 'https://u53r:p4ss@beta-bridge.simplefin.org/simplefin';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let models: typeof import('../../src/models/index.js');
let testDb: PgTestDb;
let householdId: number;
let userId: number;
let originalFetch: typeof globalThis.fetch;

// Discovered accounts the stubbed discovery call returns each connect/list.
let discovered: unknown[] = [];

before(async () => {
  process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY =
    '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  testDb = await setupPgTestDb('simplefin-links');
  models = await import('../../src/models/index.js');
  const enc = await import('../../src/util/symmetricEncryption.js');
  enc.__resetKeyCacheForTests();
  app = (await import('../../src/app.js')).default;
  authed = testAgent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'sflinks@example.com',
    displayName: 'Links User',
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

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  discovered = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === CLAIM_URL && init?.method === 'POST') {
      return new Response(ACCESS_URL, { status: 200 });
    }
    if (url.includes('/accounts')) {
      return new Response(JSON.stringify({ accounts: discovered }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('nf', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await models.SimplefinAccountLink.destroy({ where: {} });
  await models.UserSimplefinIntegration.destroy({ where: {} });
  await models.Account.destroy({ where: {} });
});

async function connect() {
  const res = await authed.post('/api/simplefin/connect').send({ setupToken: SETUP_TOKEN });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res;
}

test('AC1: a new user with no matching account can create-and-link, then GET reports it linked', async () => {
  discovered = [{ id: 'ACT-1', name: 'Joint Chequing' }];
  await connect();

  // GET lists the discovered account, unlinked, no suggestion.
  let list = await authed.get('/api/simplefin/accounts');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.accounts.length, 1);
  assert.equal(list.body.accounts[0].simplefinId, 'ACT-1');
  assert.equal(list.body.accounts[0].linkedAccountId, null);
  assert.equal(list.body.accounts[0].suggestedAccountId, null);

  // Create-and-link in one call.
  const link = await authed
    .post('/api/simplefin/accounts/ACT-1/link')
    .send({ create: { name: 'Joint Chequing', defaultCurrency: 'CAD' } });
  assert.equal(link.status, 200, JSON.stringify(link.body));
  assert.ok(link.body.linkedAccountId);
  const newAccountId = link.body.linkedAccountId;

  // The Account exists and the link persisted.
  const acct = await models.Account.findByPk(newAccountId);
  assert.ok(acct);
  assert.equal(acct!.name, 'Joint Chequing');
  list = await authed.get('/api/simplefin/accounts');
  assert.equal(list.body.accounts[0].linkedAccountId, newAccountId);
});

test('AC1: link to an existing account persists and GET reports it', async () => {
  const acct = await models.Account.create({
    name: 'My RBC', owner: 'me', ownerUserId: userId, householdId,
    accountType: 'chequing', defaultCurrency: 'CAD',
  } as never);
  discovered = [{ id: 'ACT-1', name: 'Chequing' }];
  await connect();

  const link = await authed
    .post('/api/simplefin/accounts/ACT-1/link')
    .send({ accountId: acct.id });
  assert.equal(link.status, 200, JSON.stringify(link.body));
  assert.equal(link.body.linkedAccountId, acct.id);

  const rows = await models.SimplefinAccountLink.findAll({ where: { accountId: acct.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].simplefinAccountId, 'ACT-1');
});

test('AC5: DELETE unlinks, leaves the Account intact, and is idempotent', async () => {
  const acct = await models.Account.create({
    name: 'Savings', owner: 'me', ownerUserId: userId, householdId,
    accountType: 'savings', defaultCurrency: 'CAD',
  } as never);
  discovered = [{ id: 'ACT-1', name: 'Savings' }];
  await connect();
  await authed.post('/api/simplefin/accounts/ACT-1/link').send({ accountId: acct.id });

  const del = await authed.delete('/api/simplefin/accounts/ACT-1/link');
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(del.body.linkedAccountId, null);
  assert.equal(await models.SimplefinAccountLink.count(), 0);
  // Account survives.
  assert.ok(await models.Account.findByPk(acct.id));
  // Idempotent re-delete.
  const del2 = await authed.delete('/api/simplefin/accounts/ACT-1/link');
  assert.equal(del2.status, 200);
});

test('invalid_request: neither accountId nor create → 400; both → 400', async () => {
  discovered = [{ id: 'ACT-1', name: 'X' }];
  await connect();
  const neither = await authed.post('/api/simplefin/accounts/ACT-1/link').send({});
  assert.equal(neither.status, 400);
  assert.equal(neither.body.error, 'invalid_request');
  const acct = await models.Account.create({
    name: 'Z', owner: 'me', ownerUserId: userId, householdId,
    accountType: 'chequing', defaultCurrency: 'CAD',
  } as never);
  const both = await authed
    .post('/api/simplefin/accounts/ACT-1/link')
    .send({ accountId: acct.id, create: { name: 'Z2', defaultCurrency: 'CAD' } });
  assert.equal(both.status, 400);
  assert.equal(both.body.error, 'invalid_request');
});

test('not_found: linking an unknown simplefinId → 404', async () => {
  discovered = [{ id: 'ACT-1', name: 'X' }];
  await connect();
  const acct = await models.Account.create({
    name: 'Y', owner: 'me', ownerUserId: userId, householdId,
    accountType: 'chequing', defaultCurrency: 'CAD',
  } as never);
  const res = await authed
    .post('/api/simplefin/accounts/ACT-UNKNOWN/link')
    .send({ accountId: acct.id });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});

test('AC3,7: a second integration cannot link an account already linked → 409 already_linked', async () => {
  const shared = await models.Account.create({
    name: 'Joint', owner: 'me', ownerUserId: userId, householdId,
    accountType: 'chequing', defaultCurrency: 'CAD',
  } as never);
  discovered = [{ id: 'ACT-1', name: 'Joint' }];
  await connect();
  const first = await authed
    .post('/api/simplefin/accounts/ACT-1/link')
    .send({ accountId: shared.id });
  assert.equal(first.status, 200);

  // Second household member with their own integration claiming the SAME account.
  const memberB = await models.User.create({
    email: `b-${Date.now()}@example.com`, displayName: 'B', globalRole: 'user',
    passwordHash: 'x', passwordSalt: 'x', passwordParams: '{}',
  } as never);
  await models.HouseholdMember.create({
    householdId, userId: memberB.id, role: 'member',
  } as never);
  const enc = await import('../../src/util/symmetricEncryption.js');
  const integB = await models.UserSimplefinIntegration.create({
    userId: memberB.id,
    accessUrlEncrypted: enc.encryptSecret(ACCESS_URL),
    status: 'connected', statusReason: null, lastSyncedAt: null,
  } as never);
  // Directly attempting the link via the service path → 409.
  const links = await import('../../src/simplefin/links.js');
  await assert.rejects(
    links.linkAccount({
      userId: memberB.id, householdId, simplefinId: 'ACT-1', accountId: shared.id,
    }),
    (e: unknown) =>
      e instanceof links.SimplefinLinkError && e.code === 'already_linked',
  );

  // And syncing member B imports ZERO for that account (no link exists for B).
  const { syncSimplefin } = await import('../../src/simplefin/sync.js');
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('/accounts')) {
      return new Response(
        JSON.stringify({
          accounts: [
            { id: 'ACT-1', name: 'Joint', currency: 'CAD', transactions: [
              { id: 'BTX-1', posted: 1742040000, amount: '-5.00', description: 'X', payee: 'X' },
            ] },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('nf', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  const result = await syncSimplefin({ integrationId: integB.id });
  const importedForShared = result.runs
    .filter((r) => r.accountId === shared.id)
    .reduce((n, r) => n + r.inserted, 0);
  assert.equal(importedForShared, 0, 'member B sync imports nothing for the shared account');
});

test('AC9: GET reports alreadyLinkedElsewhere for a suggested account claimed by another integration', async () => {
  const shared = await models.Account.create({
    name: 'Chequing', owner: 'me', ownerUserId: userId, householdId,
    accountType: 'chequing', defaultCurrency: 'CAD', bankAccountNumber: '1234',
  } as never);
  // Member B owns the link to `shared`.
  const memberB = await models.User.create({
    email: `b2-${Date.now()}@example.com`, displayName: 'B2', globalRole: 'user',
    passwordHash: 'x', passwordSalt: 'x', passwordParams: '{}',
  } as never);
  await models.HouseholdMember.create({
    householdId, userId: memberB.id, role: 'member',
  } as never);
  const enc = await import('../../src/util/symmetricEncryption.js');
  const integB = await models.UserSimplefinIntegration.create({
    userId: memberB.id, accessUrlEncrypted: enc.encryptSecret(ACCESS_URL),
    status: 'connected', statusReason: null, lastSyncedAt: null,
  } as never);
  await models.SimplefinAccountLink.create({
    integrationId: integB.id, simplefinAccountId: 'ACT-OTHER', accountId: shared.id,
  } as never);

  // Caller (user A) connects; discovery suggests the same `Chequing` account.
  discovered = [{ id: 'ACT-1', name: 'Chequing' }];
  await connect();
  const list = await authed.get('/api/simplefin/accounts');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const row = list.body.accounts.find((a: { simplefinId: string }) => a.simplefinId === 'ACT-1');
  assert.ok(row);
  assert.equal(row.suggestedAccountId, shared.id);
  assert.equal(row.alreadyLinkedElsewhere, true);
});

test('not_connected: GET /accounts without an integration → 404', async () => {
  const res = await authed.get('/api/simplefin/accounts');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_connected');
});

test('unauthenticated GET /api/simplefin/accounts → 401', async () => {
  const anon = testAgent(app);
  const res = await anon.get('/api/simplefin/accounts');
  assert.equal(res.status, 401);
});
