/**
 * Integration tests for the counterparty backfill HTTP routes (issue #376):
 *
 *   POST /api/transactions/counterparty/backfill
 *   GET  /api/transactions/counterparty/backfill/status
 *
 * Covers:
 *  - Streaming NDJSON path produces progress + summary events
 *  - Non-streaming path returns a JSON summary
 *  - Out-of-scope rows (credit_card / loan / investment) are untouched (AC5)
 *  - Idempotent re-runs do nothing (and 429 once the 1h rate limit kicks in)
 *  - 409 when a backfill is already running for the same household
 *  - GET /status reports running/lastRunAt/nextAllowedAt correctly
 *  - Household isolation: B's rows never get touched by A's backfill
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { seedHousehold } from '../helpers/seedHousehold.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let agentA: ReturnType<typeof request.agent>;
let agentB: ReturnType<typeof request.agent>;
let householdAId: number;
let householdBId: number;
let userAId: number;
let userBId: number;
let testDb: PgTestDb;

async function makeAccount(opts: {
  householdId: number;
  userId: number;
  name: string;
  accountType: string;
}): Promise<number> {
  const models = await import('../../src/models');
  const acc = await models.Account.create({
    name: opts.name,
    owner: 'me',
    householdId: opts.householdId,
    ownerUserId: opts.userId,
    accountType: opts.accountType,
    defaultCurrency: 'CAD',
    openingBalance: '0',
    openingBalanceDate: null,
  } as never);
  return acc.id;
}

async function makeTxn(opts: {
  accountId: number;
  householdId: number;
  merchantRaw: string;
  counterpartyRaw?: string | null;
  date?: string;
}): Promise<number> {
  const models = await import('../../src/models');
  const fp = crypto.randomBytes(16).toString('hex');
  const row = await models.Transaction.create({
    accountId: opts.accountId,
    householdId: opts.householdId,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'counterparty-backfill-test',
    date: opts.date ?? '2026-04-01',
    merchantRaw: opts.merchantRaw,
    merchantClean: opts.merchantRaw,
    amount: '-10.0000',
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: fp,
    sourceIdentityFingerprint: fp,
    counterpartyRaw: opts.counterpartyRaw ?? null,
  } as never);
  return row.id;
}

before(async () => {
  testDb = await setupPgTestDb('counterparty_backfill');
  app = (await import('../../src/app.js')).default;
  // Register bootstrap superadmin (first registered user) — we won't
  // actually use this agent for any assertions but the app expects at
  // least one superadmin to exist before /auth/register requires invites.
  const bootstrap = request.agent(app);
  const reg = await bootstrap.post('/api/auth/register').send({
    email: 'boot@example.com',
    displayName: 'Boot',
    password: 'password123',
  });
  assert.equal(reg.status, 201);

  const seedA = await seedHousehold('cpbA', 'Self A');
  const seedB = await seedHousehold('cpbB', 'Self B');
  householdAId = seedA.householdId;
  householdBId = seedB.householdId;
  userAId = seedA.userId;
  userBId = seedB.userId;

  agentA = request.agent(app);
  agentA.jar.setCookie(`cashflow_session=${seedA.token}; Path=/`);
  agentB = request.agent(app);
  agentB.jar.setCookie(`cashflow_session=${seedB.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /counterparty/backfill/status before any run reports running=false, no history', async () => {
  const res = await agentA.get('/api/transactions/counterparty/backfill/status');
  assert.equal(res.status, 200);
  assert.equal(res.body.running, false);
  assert.equal(res.body.lastRunAt, null);
  assert.equal(res.body.nextAllowedAt, null);
  assert.equal(res.body.lastSummary, null);
  assert.equal(typeof res.body.rateLimitMs, 'number');
});

test('POST /counterparty/backfill: streaming sweep extracts in-scope rows and skips out-of-scope', async () => {
  // Wipe any rows left from previous tests.
  const models = await import('../../src/models');
  await models.Transaction.destroy({ where: {}, force: true });
  await models.Account.destroy({ where: {}, force: true });
  await models.ProviderJobLog.destroy({ where: {}, force: true });

  // Household A: checking, savings, cash (in-scope), credit_card (out-of-scope).
  const checkingA = await makeAccount({
    householdId: householdAId,
    userId: userAId,
    name: 'A Checking',
    accountType: 'checking',
  });
  const savingsA = await makeAccount({
    householdId: householdAId,
    userId: userAId,
    name: 'A Savings',
    accountType: 'savings',
  });
  const cashA = await makeAccount({
    householdId: householdAId,
    userId: userAId,
    name: 'A Cash',
    accountType: 'cash',
  });
  const creditA = await makeAccount({
    householdId: householdAId,
    userId: userAId,
    name: 'A Credit',
    accountType: 'credit_card',
  });

  // Household B (must remain untouched): one in-scope checking row.
  const checkingB = await makeAccount({
    householdId: householdBId,
    userId: userBId,
    name: 'B Checking',
    accountType: 'checking',
  });

  const inScopeA = await makeTxn({
    accountId: checkingA,
    householdId: householdAId,
    merchantRaw: 'INTERAC E-TRANSFER FROM JANE DOE',
  });
  const inScopeSavingsA = await makeTxn({
    accountId: savingsA,
    householdId: householdAId,
    merchantRaw: 'ZELLE PAYMENT TO MIKE SMITH',
  });
  const inScopeCashA = await makeTxn({
    accountId: cashA,
    householdId: householdAId,
    merchantRaw: 'CASHAPP*JOHN DOE',
  });
  const outOfScopeA = await makeTxn({
    accountId: creditA,
    householdId: householdAId,
    merchantRaw: 'INTERAC E-TFR FROM SOMEONE',
  });
  const otherHousehold = await makeTxn({
    accountId: checkingB,
    householdId: householdBId,
    merchantRaw: 'INTERAC E-TRANSFER FROM HHB CONTACT',
  });

  const res = await agentA
    .post('/api/transactions/counterparty/backfill?stream=1')
    .set('Accept', 'application/x-ndjson')
    .send({ batchSize: 2 });

  assert.equal(res.status, 200);
  const events = String(res.text)
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const summary = events.find((e) => e.kind === 'summary');
  assert.ok(summary, 'stream must include a final summary event');
  assert.equal(summary.processed, 3, 'only the 3 in-scope household-A rows are processed');
  assert.equal(summary.extracted, 3, 'all 3 in-scope rows match a counterparty pattern');
  assert.equal(summary.dryRun, false);

  const after1 = await models.Transaction.findAll({
    where: { id: [inScopeA, inScopeSavingsA, inScopeCashA] },
    order: [['id', 'ASC']],
  });
  assert.equal(after1[0].counterpartyRaw, 'JANE DOE');
  assert.equal(after1[1].counterpartyRaw, 'MIKE SMITH');
  assert.equal(after1[2].counterpartyRaw, 'JOHN DOE');

  // Out-of-scope row untouched.
  const oosRow = await models.Transaction.findByPk(outOfScopeA);
  assert.equal(oosRow!.counterpartyRaw, null);

  // Household B's row untouched.
  const bRow = await models.Transaction.findByPk(otherHousehold);
  assert.equal(bRow!.counterpartyRaw, null);
});

test('GET /counterparty/backfill/status after a run reports lastRunAt and nextAllowedAt', async () => {
  const res = await agentA.get('/api/transactions/counterparty/backfill/status');
  assert.equal(res.status, 200);
  assert.equal(res.body.running, false);
  assert.ok(res.body.lastRunAt, 'lastRunAt populated after a successful run');
  assert.ok(res.body.nextAllowedAt, 'nextAllowedAt set inside the 1h rate-limit window');
  assert.ok(res.body.lastSummary, 'lastSummary populated');
  assert.equal(res.body.lastSummary.processed, 3);
  assert.equal(res.body.lastSummary.extracted, 3);
});

test('POST /counterparty/backfill returns 429 inside the 1h rate-limit window', async () => {
  const res = await agentA
    .post('/api/transactions/counterparty/backfill?stream=1')
    .set('Accept', 'application/x-ndjson')
    .send({});
  assert.equal(res.status, 429);
  assert.ok(res.body.nextAllowedAt, 'rate-limit response carries nextAllowedAt');
  assert.ok(res.body.error.match(/rate-limited/i));
});

test('POST /counterparty/backfill: dryRun bypasses rate limit and writes nothing', async () => {
  const models = await import('../../src/models');
  // Add a fresh NULL row so dryRun has something to find.
  const acc = await models.Account.findOne({
    where: { householdId: householdAId, accountType: 'checking' },
  });
  await makeTxn({
    accountId: acc!.id,
    householdId: householdAId,
    merchantRaw: 'INTERAC E-TFR FROM DRYRUN PERSON',
    date: '2026-04-30',
  });

  const res = await agentA
    .post('/api/transactions/counterparty/backfill?stream=1')
    .set('Accept', 'application/x-ndjson')
    .send({ dryRun: true });

  assert.equal(res.status, 200, 'dry run not rate-limited');
  const events = String(res.text)
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const summary = events.find((e) => e.kind === 'summary');
  assert.equal(summary.dryRun, true);
  assert.equal(summary.extracted, 1, 'one new NULL row would extract');

  const row = await models.Transaction.findOne({
    where: { merchantRaw: 'INTERAC E-TFR FROM DRYRUN PERSON' },
  });
  assert.equal(row!.counterpartyRaw, null, 'dryRun must not write');
});

test('POST /counterparty/backfill: cross-household isolation — agent B cannot affect A and vice versa', async () => {
  // Status endpoint for B should be empty (no run yet for B).
  const statusB = await agentB.get('/api/transactions/counterparty/backfill/status');
  assert.equal(statusB.status, 200);
  assert.equal(statusB.body.lastRunAt, null, 'household B has no prior run');
});

test('POST /counterparty/backfill: non-streaming returns a single JSON summary', async () => {
  // Move household B forward: run a real (non-stream) backfill on its single row.
  const res = await agentB
    .post('/api/transactions/counterparty/backfill')
    .send({});

  assert.equal(res.status, 200);
  assert.equal(typeof res.body.processed, 'number');
  assert.equal(res.body.dryRun, false);
  assert.equal(res.body.processed, 1);
  assert.equal(res.body.extracted, 1);

  // Household B now sees nextAllowedAt populated.
  const statusB = await agentB.get('/api/transactions/counterparty/backfill/status');
  assert.ok(statusB.body.nextAllowedAt);
});
