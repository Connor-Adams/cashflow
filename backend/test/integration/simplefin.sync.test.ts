/**
 * Integration tests for the SimpleFIN daily transaction sync (issue #791).
 * Postgres-backed; stubs globalThis.fetch for the connect handshake and the
 * `/accounts?start-date=` transaction fetch. Covers AC 1,3,4,5,6,8,9,10,11.
 */
import { after, before, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

const CLAIM_URL = 'https://beta-bridge.simplefin.org/simplefin/claim/tok-sync';
const SETUP_TOKEN = Buffer.from(CLAIM_URL, 'utf8').toString('base64');
const ACCESS_URL = 'https://u53r:p4ss@beta-bridge.simplefin.org/simplefin';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let models: typeof import('../../src/models/index.js');
let testDb: PgTestDb;
let householdId: number;
let userId: number;
let accountId: number;
let originalFetch: typeof globalThis.fetch;

const POSTED = 1742040000; // 2025-03-15T12:00:00Z
const POSTED_DATE = '2025-03-15';

before(async () => {
  process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY =
    '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  testDb = await setupPgTestDb('simplefin-sync');
  models = await import('../../src/models/index.js');
  const enc = await import('../../src/util/symmetricEncryption.js');
  enc.__resetKeyCacheForTests();
  app = (await import('../../src/app.js')).default;
  authed = testAgent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'sfsync@example.com',
    displayName: 'Sync User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
  const hh = await models.Household.findOne();
  assert.ok(hh);
  householdId = hh.id;
  const user = await models.User.findOne();
  assert.ok(user);
  userId = user.id;
  const account = await models.Account.create({
    name: 'Checking',
    owner: 'me',
    ownerUserId: userId,
    householdId,
    accountType: 'chequing',
    defaultCurrency: 'CAD',
  } as never);
  accountId = account.id;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  // Each test connects fresh: stub claim + empty discovery, then connect.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === CLAIM_URL && init?.method === 'POST') {
      return new Response(ACCESS_URL, { status: 200 });
    }
    if (url.includes('/accounts')) {
      return new Response(JSON.stringify({ accounts: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('nf', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  const res = await authed.post('/api/simplefin/connect').send({ setupToken: SETUP_TOKEN });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  // #813: sync resolves the target Account ONLY via an explicit
  // SimplefinAccountLink. Connect ran with empty discovery, so create the link
  // mapping the remote 'ACT-1' account to the seeded Checking account.
  const integ = await models.UserSimplefinIntegration.findOne({ where: { userId } });
  assert.ok(integ);
  await models.SimplefinAccountLink.create({
    integrationId: integ.id,
    simplefinAccountId: 'ACT-1',
    accountId,
  } as never);
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await models.Transaction.destroy({ where: {} });
  await models.ImportHistory.destroy({ where: {} });
  await models.SimplefinAccountLink.destroy({ where: {} });
  await models.UserSimplefinIntegration.destroy({ where: {} });
});

/** Stub the `/accounts?start-date=` fetch to return the given SimpleFIN payload. */
function stubTxnFetch(opts: {
  status?: number;
  accounts?: unknown[];
}) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/accounts')) {
      if (opts.status && opts.status >= 400) {
        return new Response('denied', { status: opts.status });
      }
      return new Response(JSON.stringify({ accounts: opts.accounts ?? [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('nf', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
}

const sampleAccount = (txns: unknown[]) => ({
  id: 'ACT-1',
  name: 'Checking',
  currency: 'CAD',
  transactions: txns,
});

test('AC1: simplefin_sync job is registered with daily cron, enabled', async () => {
  await import('../../src/jobs/definitions/simplefinSync.js');
  const { listDefinitions } = await import('../../src/jobs/registry.js');
  const def = listDefinitions().find((d) => d.name === 'simplefin_sync');
  assert.ok(def, 'simplefin_sync job registered');
  assert.equal(def!.cronDefault, '0 2 * * *');
  assert.equal(def!.enabledDefault, true);
});

test('AC3,5,6,10: happy path inserts txns, writes one ImportHistory, advances lastSyncedAt', async () => {
  stubTxnFetch({
    accounts: [
      sampleAccount([
        { id: 'STX-1', posted: POSTED, amount: '-10.00', description: 'STORE A', payee: 'Store A' },
        { id: 'STX-2', posted: POSTED, amount: '-20.00', description: 'STORE B', payee: 'Store B' },
      ]),
    ],
  });
  const res = await authed.post('/api/simplefin/sync').send({});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.runs.length, 1);
  assert.equal(res.body.runs[0].accountId, accountId);
  assert.equal(res.body.runs[0].inserted, 2);
  assert.equal(res.body.runs[0].skippedDuplicate, 0);
  assert.equal(res.body.runs[0].status, 'connected');

  // AC3: committed through commitStatementImport (rows exist, posted).
  const txns = await models.Transaction.findAll({ where: { accountId } });
  assert.equal(txns.length, 2);
  const byRef = new Map(txns.map((t) => [t.sourceReference, t]));
  assert.ok(byRef.has('STX-1') && byRef.has('STX-2'));
  assert.equal(byRef.get('STX-1')!.date, POSTED_DATE);
  assert.equal(byRef.get('STX-1')!.status, 'posted');

  // AC5: exactly one ImportHistory with profileId=simplefin and correct counts.
  const hist = await models.ImportHistory.findAll({ where: { accountId } });
  assert.equal(hist.length, 1);
  assert.equal(hist[0].profileId, 'simplefin');
  assert.equal(hist[0].insertedCount, 2);
  assert.equal(hist[0].skippedDuplicateCount, 0);

  // AC6: lastSyncedAt advanced, status connected.
  const integ = await models.UserSimplefinIntegration.findOne({ where: { userId } });
  assert.ok(integ!.lastSyncedAt);
  assert.equal(integ!.status, 'connected');
});

test('AC9: a second consecutive run inserts 0 new rows (idempotent)', async () => {
  stubTxnFetch({
    accounts: [
      sampleAccount([
        { id: 'STX-1', posted: POSTED, amount: '-10.00', description: 'STORE A', payee: 'Store A' },
      ]),
    ],
  });
  const first = await authed.post('/api/simplefin/sync').send({});
  assert.equal(first.body.runs[0].inserted, 1);

  const second = await authed.post('/api/simplefin/sync').send({});
  assert.equal(second.status, 200);
  assert.equal(second.body.runs[0].inserted, 0);
  assert.equal(second.body.runs[0].skippedDuplicate, 1);
  assert.equal(await models.Transaction.count({ where: { accountId } }), 1);
});

test('AC4: a CSV-imported txn with matching fingerprint is deduped, not re-inserted', async () => {
  const { stableIdentityFingerprint, rowFingerprint } = await import(
    '../../src/import/fingerprint.js'
  );
  const merchantRaw = 'Store A';
  // Pre-seed a CSV-imported posted row (no sourceReference) with the same
  // identity fingerprint the SimpleFIN row will produce.
  await models.Transaction.create({
    accountId,
    householdId,
    importBatch: 'csv-batch',
    date: POSTED_DATE,
    merchantRaw,
    merchantClean: 'store a',
    amount: '-10.00',
    currency: 'CAD',
    sourceReference: null,
    sourceRowFingerprint: rowFingerprint({
      accountId,
      date: POSTED_DATE,
      amount: -10,
      currency: 'CAD',
      merchantRaw,
      sourceReference: null,
    }),
    sourceIdentityFingerprint: stableIdentityFingerprint({
      accountId,
      date: POSTED_DATE,
      amount: -10,
      currency: 'CAD',
      merchantRaw,
    }),
    status: 'posted',
  } as never);

  stubTxnFetch({
    accounts: [
      sampleAccount([
        { id: 'STX-1', posted: POSTED, amount: '-10.00', description: 'STORE A', payee: 'Store A' },
      ]),
    ],
  });
  const res = await authed.post('/api/simplefin/sync').send({});
  assert.equal(res.body.runs[0].inserted, 0);
  assert.equal(res.body.runs[0].skippedDuplicate, 1);
  // Still exactly one row, and its sourceReference was backfilled with the SF id.
  const rows = await models.Transaction.findAll({ where: { accountId } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceReference, 'STX-1');
});

test('AC11: a pending CSV txn matching a posted SimpleFIN txn is promoted, not duplicated', async () => {
  const { stableIdentityFingerprint, rowFingerprint } = await import(
    '../../src/import/fingerprint.js'
  );
  const merchantRaw = 'Store A';
  await models.Transaction.create({
    accountId,
    householdId,
    importBatch: 'csv-pending',
    date: POSTED_DATE,
    merchantRaw,
    merchantClean: 'store a',
    amount: '-10.00',
    currency: 'CAD',
    sourceReference: null,
    sourceRowFingerprint: rowFingerprint({
      accountId,
      date: POSTED_DATE,
      amount: -10,
      currency: 'CAD',
      merchantRaw,
      sourceReference: null,
    }),
    sourceIdentityFingerprint: stableIdentityFingerprint({
      accountId,
      date: POSTED_DATE,
      amount: -10,
      currency: 'CAD',
      merchantRaw,
    }),
    status: 'pending',
  } as never);

  stubTxnFetch({
    accounts: [
      sampleAccount([
        { id: 'STX-1', posted: POSTED, amount: '-10.00', description: 'STORE A', payee: 'Store A' },
      ]),
    ],
  });
  const res = await authed.post('/api/simplefin/sync').send({});
  assert.equal(res.body.runs[0].inserted, 0);
  assert.equal(res.body.runs[0].skippedDuplicate, 1);
  const rows = await models.Transaction.findAll({ where: { accountId } });
  assert.equal(rows.length, 1, 'promoted in place, not duplicated');
  assert.equal(rows[0].status, 'posted');
  assert.equal(rows[0].sourceReference, 'STX-1');
});

test('AC8: a 401 from the access URL sets status=error and does not advance lastSyncedAt', async () => {
  const before = await models.UserSimplefinIntegration.findOne({ where: { userId } });
  const lastBefore = before!.lastSyncedAt;

  stubTxnFetch({ status: 401 });
  const res = await authed.post('/api/simplefin/sync').send({});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  // The failed integration is reported as an error run in the body.
  assert.ok(res.body.runs.some((r: { status: string }) => r.status === 'error'));

  const after = await models.UserSimplefinIntegration.findOne({ where: { userId } });
  assert.equal(after!.status, 'error');
  assert.equal(
    after!.lastSyncedAt ? after!.lastSyncedAt.getTime() : null,
    lastBefore ? lastBefore.getTime() : null,
    'lastSyncedAt unchanged',
  );
  assert.equal(await models.Transaction.count({ where: { accountId } }), 0);
});

test('AC10: unauthenticated POST /api/simplefin/sync returns 401', async () => {
  const anon = testAgent(app);
  const res = await anon.post('/api/simplefin/sync').send({});
  assert.equal(res.status, 401);
});
