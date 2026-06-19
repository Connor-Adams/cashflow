/**
 * Integration tests for Task 6 of the Interac feature:
 * counterparty_email_match suggestions surfaced in GET /api/ai/inbox.
 *
 * Harness mirrors interacCounterpartyRoutes.test.ts.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { seedHousehold } from '../helpers/seedHousehold.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let agentA: ReturnType<typeof request.agent>;
let agentB: ReturnType<typeof request.agent>;
let householdAId: number;
let householdBId: number;
let userAId: number;
let userBId: number;
let accountAId: number;
let accountBId: number;
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
}): Promise<number> {
  const models = await import('../../src/models');
  const fp = crypto.randomBytes(16).toString('hex');
  const row = await models.Transaction.create({
    accountId: opts.accountId,
    householdId: opts.householdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'interac-inbox-test',
    date: '2026-06-01',
    merchantRaw: 'INTERAC E-TFR',
    merchantClean: 'INTERAC E-TFR',
    merchantCanonical: null,
    amount: '50.0000',
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
    myShareAmount: '50',
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
    counterpartyRaw: null,
    counterpartyContactId: null,
  } as never);
  return row.id;
}

before(async () => {
  testDb = await setupPgTestDb('interac_inbox');

  const mod = await import('../../src/app.js');
  app = mod.default;

  // First registration becomes superadmin — required by the app.
  const superAgent = testAgent(app);
  const register = await superAgent.post('/api/auth/register').send({
    email: 'super-interacinbox@example.com',
    displayName: 'Super InteracInbox',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const a = await seedHousehold('InteracInboxA', 'A Partner');
  householdAId = a.householdId;
  userAId = a.userId;
  agentA = testAgent(app);
  agentA.jar.setCookie(`cashflow_session=${a.token}; Path=/`);

  const b = await seedHousehold('InteracInboxB', 'B Partner');
  householdBId = b.householdId;
  userBId = b.userId;
  agentB = testAgent(app);
  agentB.jar.setCookie(`cashflow_session=${b.token}; Path=/`);

  accountAId = await makeAccount({
    householdId: householdAId,
    userId: userAId,
    name: 'A Chequing',
    shortCode: 'IIA-CHQ',
  });
  accountBId = await makeAccount({
    householdId: householdBId,
    userId: userBId,
    name: 'B Chequing',
    shortCode: 'IIB-CHQ',
  });
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/ai/inbox includes counterparty_email_match suggestion with name and transactionId', async () => {
  const models = await import('../../src/models');

  const txnId = await makeTxn({ householdId: householdAId, accountId: accountAId });

  const suggestion = await models.AiSuggestion.create({
    householdId: householdAId,
    userId: null,
    kind: 'counterparty_email_match',
    status: 'suggested',
    transactionId: txnId,
    inputSnapshot: { messageId: 'm1', ref: 'R1' },
    output: { name: 'Stephen Masseur', isSelf: false },
  } as never);

  const res = await agentA.get('/api/ai/inbox');
  assert.equal(res.status, 200);

  const items = res.body.items as Array<{
    id: number;
    kind: string;
    transactionId: number;
    summary: string;
    output: { name?: string; isSelf?: boolean };
  }>;

  const item = items.find((i) => i.id === suggestion.id);
  assert.ok(item, 'counterparty_email_match item must appear in inbox');
  assert.equal(item.kind, 'counterparty_email_match');
  assert.equal(item.transactionId, txnId);
  assert.match(item.summary, /Stephen Masseur/);
  assert.equal((item.output as { name?: string }).name, 'Stephen Masseur');
});

test('GET /api/ai/inbox excludes counterparty_email_match rows with status != suggested', async () => {
  const models = await import('../../src/models');

  const txnId = await makeTxn({ householdId: householdAId, accountId: accountAId });

  const rejected = await models.AiSuggestion.create({
    householdId: householdAId,
    userId: null,
    kind: 'counterparty_email_match',
    status: 'rejected',
    transactionId: txnId,
    inputSnapshot: { messageId: 'm2', ref: 'R2' },
    output: { name: 'Ghost Person', isSelf: false },
  } as never);

  const res = await agentA.get('/api/ai/inbox');
  assert.equal(res.status, 200);

  const ids = (res.body.items as Array<{ id: number }>).map((i) => i.id);
  assert.ok(!ids.includes(rejected.id), 'rejected counterparty_email_match must not appear');
});

test('GET /api/ai/inbox scopes counterparty_email_match to household', async () => {
  const models = await import('../../src/models');

  // Seed a suggestion in household B.
  const txnBId = await makeTxn({ householdId: householdBId, accountId: accountBId });
  const suggestionB = await models.AiSuggestion.create({
    householdId: householdBId,
    userId: null,
    kind: 'counterparty_email_match',
    status: 'suggested',
    transactionId: txnBId,
    inputSnapshot: { messageId: 'm3', ref: 'R3' },
    output: { name: 'B Only Person', isSelf: false },
  } as never);

  // agentA must not see household B's suggestion.
  const resA = await agentA.get('/api/ai/inbox');
  assert.equal(resA.status, 200);
  const idsA = (resA.body.items as Array<{ id: number }>).map((i) => i.id);
  assert.ok(!idsA.includes(suggestionB.id), 'household A must not see household B suggestion');

  // agentB must see its own suggestion.
  const resB = await agentB.get('/api/ai/inbox');
  assert.equal(resB.status, 200);
  const idsB = (resB.body.items as Array<{ id: number }>).map((i) => i.id);
  assert.ok(idsB.includes(suggestionB.id), 'household B must see its own suggestion');
});

test('GET /api/ai/inbox isSelf:true produces self-transfer summary', async () => {
  const models = await import('../../src/models');

  const txnId = await makeTxn({ householdId: householdAId, accountId: accountAId });

  const suggestion = await models.AiSuggestion.create({
    householdId: householdAId,
    userId: null,
    kind: 'counterparty_email_match',
    status: 'suggested',
    transactionId: txnId,
    inputSnapshot: { messageId: 'm4', ref: 'R4' },
    output: { name: 'Me', isSelf: true },
  } as never);

  const res = await agentA.get('/api/ai/inbox');
  assert.equal(res.status, 200);

  const item = (res.body.items as Array<{ id: number; summary: string }>).find(
    (i) => i.id === suggestion.id,
  );
  assert.ok(item, 'isSelf suggestion must appear in inbox');
  assert.match(item.summary, /yourself/i);
});
