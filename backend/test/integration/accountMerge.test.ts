/**
 * Integration tests for account merge / consolidation (#287) over HTTP +
 * Postgres. Exercises the real auth boundary and the merge route end-to-end:
 *
 *  - POST /api/accounts/:sourceId/merge-into/:targetId moves transactions and
 *    flags the source (AC #2, #4).
 *  - Default GET /api/accounts excludes merged sources; ?includeMerged=true
 *    includes them (AC #9, #10).
 *  - Validation error codes + statuses: SAME_ID, CURRENCY_MISMATCH,
 *    TARGET_NOT_MERGEABLE, SOURCE_ALREADY_MERGED (AC #5-#8).
 *  - Deleting a merge target is blocked while sources point at it (FK guard).
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let testDb: PgTestDb;
let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let householdId: number;

before(async () => {
  testDb = await setupPgTestDb('account-merge');
  app = (await import('../../src/app.js')).default;
  authed = testAgent(app);
  const reg = await authed.post('/api/auth/register').send({
    email: 'merge-int@example.com',
    displayName: 'Merge Int',
    password: 'password123',
  });
  assert.equal(reg.status, 201, `register failed: ${JSON.stringify(reg.body)}`);
  householdId = (reg.body.user.household?.id ?? reg.body.user.householdId) as number;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

async function makeAccount(name: string, currency = 'CAD') {
  const res = await authed
    .post('/api/accounts')
    .send({ name, defaultCurrency: currency, accountType: 'checking', visibility: 'shared' });
  assert.equal(res.status, 201, `create account failed: ${JSON.stringify(res.body)}`);
  return res.body.id as number;
}

async function seedTxn(accountId: number) {
  const { Transaction } = await import('../../src/models');
  await Transaction.create({
    accountId,
    householdId,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'merge-int',
    date: '2026-01-10',
    merchantRaw: 'Test',
    merchantClean: 'Test',
    amount: '-100.0000',
    currency: 'CAD',
    txnType: 'purchase',
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
  } as never);
}

test('merge moves transactions + flags source; GET filters merged (AC #2,#4,#9,#10)', async () => {
  const source = await makeAccount('Old BoA');
  const target = await makeAccount('New BoA');
  await seedTxn(source);
  await seedTxn(source);

  const res = await authed.post(`/api/accounts/${source}/merge-into/${target}`).send({});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.movedTransactions, 2);
  assert.equal(res.body.source.mergedIntoId, target);
  assert.ok(res.body.source.mergedAt, 'source should carry mergedAt');

  const { Transaction } = await import('../../src/models');
  assert.equal(await Transaction.count({ where: { accountId: target } }), 2);
  assert.equal(await Transaction.count({ where: { accountId: source } }), 0);

  // Default list excludes the merged source.
  const def = await authed.get('/api/accounts');
  assert.equal(def.status, 200);
  const defIds = (def.body as Array<{ id: number }>).map((a) => a.id);
  assert.ok(!defIds.includes(source), 'merged source must be hidden by default');
  assert.ok(defIds.includes(target), 'target must remain visible');

  // ?includeMerged=true surfaces it.
  const all = await authed.get('/api/accounts?includeMerged=true');
  assert.equal(all.status, 200);
  const allIds = (all.body as Array<{ id: number }>).map((a) => a.id);
  assert.ok(allIds.includes(source), 'includeMerged=true must surface the merged source');
});

test('same-id returns 400 SAME_ID (AC #8)', async () => {
  const a = await makeAccount('Solo');
  const res = await authed.post(`/api/accounts/${a}/merge-into/${a}`).send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'SAME_ID');
});

test('currency mismatch returns 400 CURRENCY_MISMATCH (AC #5)', async () => {
  const usd = await makeAccount('USD acct', 'USD');
  const cad = await makeAccount('CAD acct', 'CAD');
  const res = await authed.post(`/api/accounts/${usd}/merge-into/${cad}`).send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'CURRENCY_MISMATCH');
});

test('target-already-merged returns 400 TARGET_NOT_MERGEABLE (AC #6)', async () => {
  const a = await makeAccount('A');
  const b = await makeAccount('B');
  const c = await makeAccount('C');
  // Merge b -> c first, so b is now a merged source.
  const first = await authed.post(`/api/accounts/${b}/merge-into/${c}`).send({});
  assert.equal(first.status, 200, JSON.stringify(first.body));
  // Now a -> b must fail (b is merged).
  const res = await authed.post(`/api/accounts/${a}/merge-into/${b}`).send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'TARGET_NOT_MERGEABLE');
});

test('source-already-merged returns 400 SOURCE_ALREADY_MERGED (AC #7)', async () => {
  const a = await makeAccount('Src');
  const b = await makeAccount('Mid');
  const d = await makeAccount('Other');
  const first = await authed.post(`/api/accounts/${a}/merge-into/${b}`).send({});
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const res = await authed.post(`/api/accounts/${a}/merge-into/${d}`).send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'SOURCE_ALREADY_MERGED');
});

test('missing account returns 404 NOT_FOUND', async () => {
  const t = await makeAccount('Target only');
  const res = await authed.post(`/api/accounts/999999/merge-into/${t}`).send({});
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'NOT_FOUND');
});

test('deleting a merge target is blocked while sources point at it', async () => {
  const source = await makeAccount('SrcDel');
  const target = await makeAccount('TgtDel');
  const merge = await authed.post(`/api/accounts/${source}/merge-into/${target}`).send({});
  assert.equal(merge.status, 200, JSON.stringify(merge.body));
  const del = await authed.delete(`/api/accounts/${target}`);
  assert.equal(del.status, 400);
  assert.equal(del.body.error, 'ACCOUNT_HAS_MERGED_SOURCES');
});
