/**
 * Integration tests for Task 5 Interac routes (Task 5 of Interac feature).
 *
 * Tests:
 *   - POST /interac-counterparty/sync — returns summary with processed=0 when
 *     no matching txns exist (no Gmail needed; 0 txns short-circuits).
 *   - GET  /interac-counterparty/status — after a sync, reports lastRunAt
 *     non-null and lastSummary.
 *   - POST /:id/interac-counterparty/accept — seed nameless Interac txn +
 *     AiSuggestion; accept → txn gets counterpartyRaw + counterpartyContactId.
 *   - accept with isSelf:true → txn gets counterpartyRaw but counterpartyContactId
 *     stays null.
 *
 * Harness mirrors transactionCounterpartyPromote.test.ts.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { seedHousehold } from '../helpers/seedHousehold.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let agentA: ReturnType<typeof request.agent>;
let householdAId: number;
let userAId: number;
let accountAId: number;
let testDb: PgTestDb;

async function makeAccount(opts: {
  householdId: number;
  userId: number;
  name: string;
  shortCode: string;
}): Promise<number> {
  const models = await import('../../src/models');
  const acc = await models.Account.create({
    householdId: opts.householdId,
    ownerUserId: opts.userId,
    owner: 'me',
    visibility: 'shared',
    name: opts.name,
    accountType: 'checking',
    defaultCurrency: 'CAD',
    shortCode: opts.shortCode,
  });
  return acc.id;
}

async function makeTxn(opts: {
  householdId: number;
  accountId: number;
  merchantRaw: string;
  amount: string;
  date: string;
  counterpartyRaw?: string | null;
}): Promise<number> {
  const models = await import('../../src/models');
  const fp = crypto.randomBytes(16).toString('hex');
  const row = await models.Transaction.create({
    accountId: opts.accountId,
    householdId: opts.householdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'interac-routes-test',
    date: opts.date,
    merchantRaw: opts.merchantRaw,
    merchantClean: opts.merchantRaw,
    merchantCanonical: null,
    amount: opts.amount,
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: fp,
    sourceIdentityFingerprint: fp,
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: null,
    autoBusiness: null,
    businessOverride: null,
    finalBusiness: false,
    autoSplitType: null,
    splitOverride: null,
    finalSplitType: 'me',
    autoPctMe: null,
    pctMeOverride: null,
    finalPctMe: null,
    autoPctPartner: null,
    pctPartnerOverride: null,
    finalPctPartner: null,
    myShareAmount: '0',
    partnerShareAmount: '0',
    businessAmount: '0',
    txnType: 'purchase',
    autoSource: null,
    autoConfidence: null,
    linkedTransactionId: null,
    isRecurring: false,
    reviewFlag: false,
    reviewedAt: null,
    createdByUserId: null,
    counterpartyRaw: opts.counterpartyRaw ?? null,
    counterpartyContactId: null,
  } as never);
  return row.id;
}

before(async () => {
  testDb = await setupPgTestDb('interac_routes');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const superAgent = request.agent(app);
  const register = await superAgent.post('/api/auth/register').send({
    email: 'super-iroutes@example.com',
    displayName: 'Super IRoutes',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const a = await seedHousehold('IRoutesA', 'A Partner');
  householdAId = a.householdId;
  userAId = a.userId;
  agentA = request.agent(app);
  agentA.jar.setCookie(`cashflow_session=${a.token}; Path=/`);

  accountAId = await makeAccount({
    householdId: householdAId,
    userId: userAId,
    name: 'IRoutes Chequing',
    shortCode: 'IRO-CHQ',
  });
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// ---------------------------------------------------------------------------
// Route A: POST /interac-counterparty/sync
// ---------------------------------------------------------------------------

test('POST /interac-counterparty/sync with no matching txns returns processed:0', async () => {
  const res = await agentA
    .post('/api/transactions/interac-counterparty/sync')
    .send({ dryRun: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(typeof res.body.processed, 'number', 'processed is a number');
  assert.equal(res.body.processed, 0, 'processed = 0 when no Interac txns');
  assert.equal(res.body.dryRun, true, 'dryRun echoed back');
});

// ---------------------------------------------------------------------------
// Route B: GET /interac-counterparty/status
// ---------------------------------------------------------------------------

test('GET /interac-counterparty/status after a real sync reports lastRunAt non-null and lastSummary', async () => {
  // Run a real (non-dry) sync with no matching txns to produce a ProviderJobLog row.
  const syncRes = await agentA
    .post('/api/transactions/interac-counterparty/sync')
    .send({});
  assert.equal(syncRes.status, 200, JSON.stringify(syncRes.body));

  const res = await agentA.get('/api/transactions/interac-counterparty/status');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(typeof res.body.running, 'boolean', 'running is boolean');
  assert.ok(res.body.lastRunAt !== null, 'lastRunAt is non-null after a run');
  // lastSummary should be the parsed result object from errorMessage
  assert.ok(res.body.lastSummary !== null, 'lastSummary is non-null after a run');
  assert.equal(typeof res.body.lastSummary.processed, 'number', 'lastSummary.processed is a number');
});

// ---------------------------------------------------------------------------
// Route C: POST /:id/interac-counterparty/accept
// ---------------------------------------------------------------------------

test('accept: txn gets counterpartyRaw + counterpartyContactId when isSelf:false', async () => {
  const models = await import('../../src/models');

  // Seed a nameless Interac txn
  const txnId = await makeTxn({
    householdId: householdAId,
    accountId: accountAId,
    merchantRaw: 'Interac e-Transfer® Out',
    amount: '-5000.0000',
    date: '2026-01-15',
    counterpartyRaw: null,
  });

  // Seed an AiSuggestion
  const suggestion = await models.AiSuggestion.create({
    householdId: householdAId,
    userId: userAId,
    transactionId: txnId,
    kind: 'counterparty_email_match',
    status: 'suggested',
    inputSnapshot: { messageId: 'm-test', ref: 'R-test' },
    output: { name: 'Stephen Masseur', isSelf: false },
    finalSnapshot: null,
    model: 'deterministic',
    promptVersion: 'interac-email-match-v1',
  } as never);

  const res = await agentA
    .post(`/api/transactions/${txnId}/interac-counterparty/accept`)
    .send({ suggestionId: suggestion.id });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.suggestionId, suggestion.id, 'suggestionId echoed');
  assert.equal(res.body.transaction.counterpartyRaw, 'Stephen Masseur', 'counterpartyRaw set');
  assert.ok(res.body.transaction.counterpartyContactId != null, 'counterpartyContactId non-null');

  // Verify the suggestion is accepted in the DB
  const updatedSuggestion = await models.AiSuggestion.findByPk(suggestion.id);
  assert.equal(updatedSuggestion!.status, 'accepted', 'suggestion marked accepted');
});

test('accept with isSelf:true: txn gets counterpartyRaw, counterpartyContactId stays null', async () => {
  const models = await import('../../src/models');

  const txnId = await makeTxn({
    householdId: householdAId,
    accountId: accountAId,
    merchantRaw: 'Interac e-Transfer® Received',
    amount: '5000.0000',
    date: '2026-01-16',
    counterpartyRaw: null,
  });

  const suggestion = await models.AiSuggestion.create({
    householdId: householdAId,
    userId: userAId,
    transactionId: txnId,
    kind: 'counterparty_email_match',
    status: 'suggested',
    inputSnapshot: { messageId: 'm-self', ref: 'R-self' },
    output: { name: 'Connor Adams', isSelf: true },
    finalSnapshot: null,
    model: 'deterministic',
    promptVersion: 'interac-email-match-v1',
  } as never);

  const res = await agentA
    .post(`/api/transactions/${txnId}/interac-counterparty/accept`)
    .send({ suggestionId: suggestion.id });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.transaction.counterpartyRaw, 'Connor Adams', 'counterpartyRaw set');
  assert.equal(res.body.transaction.counterpartyContactId, null, 'counterpartyContactId stays null for self');

  const updatedSuggestion = await models.AiSuggestion.findByPk(suggestion.id);
  assert.equal(updatedSuggestion!.status, 'accepted', 'suggestion marked accepted');
});

test('accept rejects cross-txn-id: suggestion belongs to txnA, POST to txnB returns 400 and leaves txnB untouched', async () => {
  const models = await import('../../src/models');

  // Seed two nameless Interac txns
  const txnAId = await makeTxn({
    householdId: householdAId,
    accountId: accountAId,
    merchantRaw: 'Interac e-Transfer® Out',
    amount: '-2500.0000',
    date: '2026-02-01',
    counterpartyRaw: null,
  });
  const txnBId = await makeTxn({
    householdId: householdAId,
    accountId: accountAId,
    merchantRaw: 'Interac e-Transfer® Out',
    amount: '-1200.0000',
    date: '2026-02-02',
    counterpartyRaw: null,
  });

  // AiSuggestion belongs to txnA
  const suggestion = await models.AiSuggestion.create({
    householdId: householdAId,
    userId: userAId,
    transactionId: txnAId,
    kind: 'counterparty_email_match',
    status: 'suggested',
    inputSnapshot: { messageId: 'm-cross', ref: 'R-cross' },
    output: { name: 'Alice Cross', isSelf: false },
    finalSnapshot: null,
    model: 'deterministic',
    promptVersion: 'interac-email-match-v1',
  } as never);

  // POST to txnB with txnA's suggestion → must be rejected
  const res = await agentA
    .post(`/api/transactions/${txnBId}/interac-counterparty/accept`)
    .send({ suggestionId: suggestion.id });

  assert.equal(res.status, 400, `expected 400 but got ${res.status}: ${JSON.stringify(res.body)}`);

  // txnB must remain completely untouched
  const txnB = await models.Transaction.findByPk(txnBId);
  assert.equal(txnB!.counterpartyContactId, null, 'txnB counterpartyContactId stays null');
});
