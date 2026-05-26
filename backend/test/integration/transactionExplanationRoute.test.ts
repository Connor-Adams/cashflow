/**
 * Integration tests for GET /api/transactions/:id/explanation (issue #230).
 *
 * Setup mirrors `transactions.test.ts`: an isolated Postgres DB, a bootstrap
 * superadmin, plus a non-superadmin household seeded via the shared
 * `seedHousehold` helper. Fixture transactions are written directly with
 * `Transaction.create` so each test owns its own auth state.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { seedHousehold } from '../helpers/seedHousehold.js';
import {
  setupPgTestDb,
  teardownPgTestDb,
  type PgTestDb,
} from './_setup/pgTestDb.js';

let app: import('express').Express;
let superAgent: ReturnType<typeof request.agent>;
let agentA: ReturnType<typeof request.agent>;
let agentB: ReturnType<typeof request.agent>;
let householdAId: number;
let householdBId: number;
let userAId: number;
let accountAId: number;
let accountBId: number;
let testDb: PgTestDb;

async function createTxn(over: Record<string, unknown>): Promise<number> {
  const models = await import('../../src/models');
  const row = await models.Transaction.create({
    accountId: accountAId,
    householdId: householdAId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'explanation-test',
    date: '2026-05-01',
    merchantRaw: 'Test',
    merchantClean: 'Test',
    amount: '-10.0000',
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
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
    myShareAmount: '-10.0000',
    partnerShareAmount: '0.0000',
    businessAmount: '0.0000',
    txnType: 'purchase',
    autoSource: null,
    autoConfidence: null,
    linkedTransactionId: null,
    isRecurring: false,
    reviewFlag: false,
    reviewedAt: null,
    createdByUserId: userAId,
    ...over,
  });
  return row.id;
}

before(async () => {
  testDb = await setupPgTestDb('txn_explanation');

  const mod = await import('../../src/app.js');
  app = mod.default;

  superAgent = request.agent(app);
  const register = await superAgent.post('/api/auth/register').send({
    email: 'super-explain@example.com',
    displayName: 'Super Explain',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const a = await seedHousehold('ExplainA', 'A Partner');
  householdAId = a.householdId;
  userAId = a.userId;
  agentA = request.agent(app);
  agentA.jar.setCookie(`cashflow_session=${a.token}; Path=/`);

  const b = await seedHousehold('ExplainB', 'B Partner');
  householdBId = b.householdId;
  agentB = request.agent(app);
  agentB.jar.setCookie(`cashflow_session=${b.token}; Path=/`);

  const models = await import('../../src/models');
  const acctA = await models.Account.create({
    householdId: householdAId,
    ownerUserId: userAId,
    owner: 'me',
    visibility: 'shared',
    name: 'A Chequing',
    accountType: 'checking',
    defaultCurrency: 'CAD',
    shortCode: 'A-CHQ',
  });
  accountAId = acctA.id;
  const acctB = await models.Account.create({
    householdId: householdBId,
    ownerUserId: b.userId,
    owner: 'me',
    visibility: 'shared',
    name: 'B Chequing',
    accountType: 'checking',
    defaultCurrency: 'CAD',
    shortCode: 'B-CHQ',
  });
  accountBId = acctB.id;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /:id/explanation: rule-applied row returns rule attribution + signal rationale', async () => {
  const models = await import('../../src/models');
  const rule = await models.Rule.create({
    householdId: householdAId,
    createdByUserId: userAId,
    merchantPattern: 'COSTCO',
    matchKind: 'substring',
    priority: 0,
    category: 'Groceries',
    isBusiness: false,
    splitType: 'shared',
    pctMe: null,
    pctPartner: null,
    effectiveFrom: null,
    effectiveTo: null,
  });
  const id = await createTxn({
    merchantRaw: 'COSTCO WHOLESALE',
    merchantClean: 'COSTCO WHOLESALE',
    appliedRuleId: rule.id,
    autoSource: 'rule',
    autoCategory: 'Groceries',
    finalCategory: 'Groceries',
    autoSplitType: 'shared',
    finalSplitType: 'shared',
  });

  const res = await agentA.get(`/api/transactions/${id}/explanation`);
  assert.equal(res.status, 200);
  assert.equal(res.body.transactionId, id);
  assert.equal(res.body.category.source, 'rule');
  assert.equal(res.body.category.value, 'Groceries');
  assert.equal(res.body.category.appliedRule.id, rule.id);
  assert.equal(res.body.category.appliedRule.merchantPattern, 'COSTCO');
  assert.equal(res.body.split.source, 'rule');
  assert.equal(res.body.split.value, 'shared');
});

test('GET /:id/explanation: manual override surfaces actor displayName + edit timestamp', async () => {
  const id = await createTxn({
    merchantRaw: 'Some Cafe',
    merchantClean: 'Some Cafe',
    categoryOverride: 'Dining',
    finalCategory: 'Dining',
    autoCategory: null,
    autoSource: null,
  });

  const res = await agentA.get(`/api/transactions/${id}/explanation`);
  assert.equal(res.status, 200);
  assert.equal(res.body.category.source, 'manual');
  assert.equal(res.body.category.value, 'Dining');
  assert.ok(res.body.category.manualEdit, 'manualEdit attribution missing');
  assert.equal(res.body.category.manualEdit.actorUserId, userAId);
  assert.equal(res.body.category.manualEdit.actorDisplayName, 'ExplainA');
  // ISO-8601 timestamp string (Date round-trips through JSON to string)
  assert.match(
    res.body.category.manualEdit.at,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
  );
});

test('GET /:id/explanation: ai source attribution when accepted AI suggestion matches override', async () => {
  const models = await import('../../src/models');
  const id = await createTxn({
    merchantRaw: 'Anthropic',
    merchantClean: 'Anthropic',
    categoryOverride: 'Subscriptions',
    finalCategory: 'Subscriptions',
  });
  await models.AiSuggestion.create({
    householdId: householdAId,
    userId: userAId,
    transactionId: id,
    receiptId: null,
    kind: 'transaction_fields',
    status: 'accepted',
    inputSnapshot: null,
    output: { category: 'Subscriptions' },
    finalSnapshot: null,
    model: 'gpt-4o-mini',
    promptVersion: null,
    temperature: null,
    latencyMs: null,
    providerRequestId: null,
    errorMessage: null,
  });

  const res = await agentA.get(`/api/transactions/${id}/explanation`);
  assert.equal(res.status, 200);
  assert.equal(res.body.category.source, 'ai');
  assert.equal(res.body.category.value, 'Subscriptions');
  assert.ok(res.body.category.aiSuggestion);
  assert.equal(res.body.category.aiSuggestion.status, 'accepted');
  assert.equal(res.body.category.aiSuggestion.model, 'gpt-4o-mini');
});

test('GET /:id/explanation: fallback message when no source recorded (legacy row)', async () => {
  const id = await createTxn({
    merchantRaw: 'Legacy Row',
    merchantClean: 'Legacy Row',
    finalCategory: null,
    autoCategory: null,
    autoSource: null,
  });

  const res = await agentA.get(`/api/transactions/${id}/explanation`);
  assert.equal(res.status, 200);
  assert.equal(res.body.category.source, 'fallback');
  assert.equal(res.body.category.value, null);
  assert.match(res.body.category.message, /not yet categorised/i);
  // Split has a NOT NULL DB default — falls back to default 'me'.
  assert.equal(res.body.split.source, 'fallback');
  assert.equal(res.body.split.value, 'me');
});

test('GET /:id/explanation: review state — needs-review / cleared / never-flagged', async () => {
  const needsReviewId = await createTxn({
    merchantRaw: 'NeedsReview',
    merchantClean: 'NeedsReview',
    reviewFlag: true,
    reviewedAt: null,
  });
  const clearedId = await createTxn({
    merchantRaw: 'Cleared',
    merchantClean: 'Cleared',
    reviewFlag: false,
    reviewedAt: new Date('2026-05-15T12:00:00Z'),
  });
  const neverFlaggedId = await createTxn({
    merchantRaw: 'NeverFlagged',
    merchantClean: 'NeverFlagged',
    reviewFlag: false,
    reviewedAt: null,
  });

  const a = await agentA.get(`/api/transactions/${needsReviewId}/explanation`);
  assert.equal(a.body.review.state, 'needs-review');
  const b = await agentA.get(`/api/transactions/${clearedId}/explanation`);
  assert.equal(b.body.review.state, 'cleared');
  assert.equal(b.body.review.lastChangedAt, '2026-05-15T12:00:00.000Z');
  const c = await agentA.get(`/api/transactions/${neverFlaggedId}/explanation`);
  assert.equal(c.body.review.state, 'never-flagged');
});

test('GET /:id/explanation: 404 when txn belongs to another household (visibleTransactionWhere isolation)', async () => {
  // Seed a row in household B.
  const models = await import('../../src/models');
  const row = await models.Transaction.create({
    accountId: accountBId,
    householdId: householdBId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'cross-tenant',
    date: '2026-05-01',
    merchantRaw: 'Foreign',
    merchantClean: 'Foreign',
    amount: '-10.0000',
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: 'Foreign',
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
    myShareAmount: '-10.0000',
    partnerShareAmount: '0.0000',
    businessAmount: '0.0000',
    txnType: 'purchase',
    autoSource: null,
    autoConfidence: null,
    linkedTransactionId: null,
    isRecurring: false,
    reviewFlag: false,
    reviewedAt: null,
    createdByUserId: null,
  });

  const res = await agentA.get(`/api/transactions/${row.id}/explanation`);
  assert.equal(res.status, 404);
});

test('GET /:id/explanation: 400 on non-integer id', async () => {
  const res = await agentA.get('/api/transactions/abc/explanation');
  assert.equal(res.status, 400);
});

test('GET /:id/explanation: superadmin can fetch any txn (no household filter)', async () => {
  const models = await import('../../src/models');
  const row = await models.Transaction.create({
    accountId: accountBId,
    householdId: householdBId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'superadmin-test',
    date: '2026-05-01',
    merchantRaw: 'Foreign for super',
    merchantClean: 'Foreign for super',
    amount: '-1.0000',
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: 'Foreign',
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
    myShareAmount: '-1.0000',
    partnerShareAmount: '0.0000',
    businessAmount: '0.0000',
    txnType: 'purchase',
    autoSource: null,
    autoConfidence: null,
    linkedTransactionId: null,
    isRecurring: false,
    reviewFlag: false,
    reviewedAt: null,
    createdByUserId: null,
  });

  const res = await superAgent.get(`/api/transactions/${row.id}/explanation`);
  assert.equal(res.status, 200);
  assert.equal(res.body.transactionId, row.id);
});

test('GET /:id/explanation: import-default attribution when autoSource is memory + signal rationale flows through', async () => {
  const models = await import('../../src/models');
  const id = await createTxn({
    merchantRaw: 'Coffee Shop',
    merchantClean: 'Coffee Shop',
    autoCategory: 'Coffee',
    finalCategory: 'Coffee',
    autoSource: 'memory',
    autoConfidence: 'high',
  });
  await models.TransactionSignal.create({
    transactionId: id,
    source: 'memory',
    confidence: 'high',
    fields: { autoCategory: 'Coffee' },
    rationale: 'Matched 3 prior reviewed transactions at this merchant',
  });

  const res = await agentA.get(`/api/transactions/${id}/explanation`);
  assert.equal(res.status, 200);
  assert.equal(res.body.category.source, 'import-default');
  assert.equal(res.body.category.autoSourceLabel, 'memory');
  assert.equal(
    res.body.category.signalRationale,
    'Matched 3 prior reviewed transactions at this merchant',
  );
});

test('GET /:id/explanation: notes manual edit attribution', async () => {
  const id = await createTxn({
    merchantRaw: 'Office Supplies',
    merchantClean: 'Office Supplies',
    notes: 'Q2 reimbursement',
  });

  const res = await agentA.get(`/api/transactions/${id}/explanation`);
  assert.equal(res.status, 200);
  assert.equal(res.body.notes.source, 'manual');
  assert.equal(res.body.notes.value, 'Q2 reimbursement');
  assert.ok(res.body.notes.manualEdit);
});
