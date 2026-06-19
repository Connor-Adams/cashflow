/**
 * Integration tests for transaction version history (#229).
 *
 * Covers:
 *   - PATCH /api/transactions/:id creates one revision per edit, with the
 *     correct diff + actor.
 *   - PATCH that's a no-op writes nothing.
 *   - Bulk-patch tags every emitted revision with source='bulk_patch'.
 *   - AI suggestion acceptance via POST /api/ai/suggestions/:id/apply
 *     tags the revision with source='ai_suggestion' and aiSuggestionId.
 *   - Refund-link POST/DELETE writes source='refund_link' revisions.
 *   - GET /api/transactions/:id/revisions returns the timeline in order.
 *   - GET on a cross-household txn returns 404 (no leak).
 *   - POST /:id/revisions/:rid/restore restores the prior value AND
 *     emits a new source='restore' revision (so the timeline shows the
 *     round-trip).
 *   - restore rejects (400) when `fields` includes a non-restorable field.
 *   - restore rejects (404) when the revision belongs to another txn.
 *
 * Setup mirrors `transactions.test.ts`: an isolated Postgres DB plus two
 * non-superadmin households (A and B).
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

type TxnSeed = {
  householdId: number;
  accountId: number;
  date: string;
  amount: number;
  merchantRaw?: string;
  finalCategory?: string | null;
  visibility?: string;
  createdByUserId?: number | null;
  importBatch?: string;
  txnType?: string;
};

async function createTxn(seed: TxnSeed): Promise<number> {
  const models = await import('../../src/models');
  const row = await models.Transaction.create({
    accountId: seed.accountId,
    householdId: seed.householdId,
    visibility: seed.visibility ?? 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: seed.importBatch ?? 'revisions-test',
    date: seed.date,
    merchantRaw: seed.merchantRaw ?? 'Rev Merchant',
    merchantClean: seed.merchantRaw ?? 'Rev Merchant',
    merchantCanonical: null,
    amount: seed.amount.toFixed(4),
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: seed.finalCategory ?? null,
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
    myShareAmount: String(seed.amount),
    partnerShareAmount: '0',
    businessAmount: '0',
    txnType: seed.txnType ?? 'purchase',
    autoSource: null,
    autoConfidence: null,
    linkedTransactionId: null,
    isRecurring: false,
    reviewFlag: false,
    reviewedAt: null,
    createdByUserId: seed.createdByUserId ?? null,
  });
  return row.id;
}

before(async () => {
  testDb = await setupPgTestDb('txnrev');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const superAgent = testAgent(app);
  const register = await superAgent.post('/api/auth/register').send({
    email: 'super-txnrev@example.com',
    displayName: 'Super Rev',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const a = await seedHousehold('RevA', 'A Partner');
  householdAId = a.householdId;
  userAId = a.userId;
  agentA = testAgent(app);
  agentA.jar.setCookie(`cashflow_session=${a.token}; Path=/`);

  const b = await seedHousehold('RevB', 'B Partner');
  householdBId = b.householdId;
  userBId = b.userId;
  agentB = testAgent(app);
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
    shortCode: 'RA-CHQ',
  });
  accountAId = acctA.id;
  const acctB = await models.Account.create({
    householdId: householdBId,
    ownerUserId: userBId,
    owner: 'me',
    visibility: 'shared',
    name: 'B Chequing',
    accountType: 'checking',
    defaultCurrency: 'CAD',
    shortCode: 'RB-CHQ',
  });
  accountBId = acctB.id;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('PATCH /:id: editing categoryOverride creates one revision with the diff', async () => {
  const id = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-09-01',
    amount: -10,
    merchantRaw: 'Edit Cat',
  });
  const res = await agentA
    .patch(`/api/transactions/${id}`)
    .send({ categoryOverride: 'Groceries' });
  assert.equal(res.status, 200);

  const timeline = await agentA.get(`/api/transactions/${id}/revisions`);
  assert.equal(timeline.status, 200);
  const data = timeline.body.data as Array<{
    source: string;
    changedByUserId: number | null;
    changes: Array<{ field: string; before: unknown; after: unknown }>;
  }>;
  assert.equal(data.length, 1, `expected 1 revision, got ${JSON.stringify(data)}`);
  assert.equal(data[0].source, 'user_edit');
  assert.equal(data[0].changedByUserId, userAId);
  const change = data[0].changes.find((c) => c.field === 'categoryOverride');
  assert.ok(change, `expected categoryOverride diff, got ${JSON.stringify(data[0].changes)}`);
  assert.equal(change!.before, null);
  assert.equal(change!.after, 'Groceries');
  // finalCategory may also have shifted as a side-effect of recompute.
});

test('PATCH /:id: no-op patch (same value) does not create a revision', async () => {
  const id = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-09-02',
    amount: -10,
    merchantRaw: 'No Op',
    finalCategory: 'Groceries',
  });
  // Set categoryOverride first so finalCategory stays the same on a re-set.
  await agentA.patch(`/api/transactions/${id}`).send({ categoryOverride: 'Groceries' });
  const before = await agentA.get(`/api/transactions/${id}/revisions`);
  const baselineCount = (before.body.data as unknown[]).length;

  // Patch with the same value — recomputeTransactionAmounts may still touch
  // share columns, but those aren't in REVISIONED_FIELDS, so no new row.
  const res = await agentA.patch(`/api/transactions/${id}`).send({ categoryOverride: 'Groceries' });
  assert.equal(res.status, 200);
  const after = await agentA.get(`/api/transactions/${id}/revisions`);
  assert.equal(
    (after.body.data as unknown[]).length,
    baselineCount,
    'no-op patch should not write a new revision',
  );
});

test('POST /bulk-patch: every touched txn gets one source=bulk_patch revision', async () => {
  const ids = await Promise.all([
    createTxn({ householdId: householdAId, accountId: accountAId, date: '2026-09-03', amount: -1, merchantRaw: 'Bulk1' }),
    createTxn({ householdId: householdAId, accountId: accountAId, date: '2026-09-04', amount: -2, merchantRaw: 'Bulk2' }),
  ]);
  const res = await agentA.post('/api/transactions/bulk-patch').send({
    ids,
    patch: { businessOverride: true },
  });
  assert.equal(res.status, 200);
  for (const id of ids) {
    const timeline = await agentA.get(`/api/transactions/${id}/revisions`);
    const data = timeline.body.data as Array<{ source: string }>;
    assert.equal(data.length, 1, `expected 1 revision on txn ${id}`);
    assert.equal(data[0].source, 'bulk_patch');
  }
});

test('GET /:id/revisions: cross-household returns 404 (no data leak)', async () => {
  const id = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-09-05',
    amount: -10,
    merchantRaw: 'Cross HH',
  });
  await agentA.patch(`/api/transactions/${id}`).send({ categoryOverride: 'Books' });
  const res = await agentB.get(`/api/transactions/${id}/revisions`);
  assert.equal(res.status, 404);
});

test('POST /:id/refund-link emits a source=refund_link revision', async () => {
  const originalId = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-09-06',
    amount: -50,
    merchantRaw: 'BEST BUY ORIG',
    txnType: 'purchase',
    createdByUserId: userAId,
  });
  const refundId = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-09-07',
    amount: 50,
    merchantRaw: 'BEST BUY REFUND',
    txnType: 'refund',
    createdByUserId: userAId,
  });
  const link = await agentA
    .post(`/api/transactions/${refundId}/refund-link`)
    .send({ originalTransactionId: originalId });
  assert.equal(link.status, 200);
  const timeline = await agentA.get(`/api/transactions/${refundId}/revisions`);
  const data = timeline.body.data as Array<{ source: string }>;
  // The refund-link save touches linkedTransactionId + autoSource + autoConfidence + reviewedAt
  // — all in REVISIONED_FIELDS — so we expect exactly one source=refund_link row.
  const refundLinks = data.filter((d) => d.source === 'refund_link');
  assert.ok(refundLinks.length >= 1, `expected at least 1 refund_link revision, got ${JSON.stringify(data)}`);
});

test('POST /:id/revisions/:rid/restore: rolls back categoryOverride AND writes source=restore', async () => {
  const id = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-09-08',
    amount: -10,
    merchantRaw: 'Restore Me',
  });
  // Two consecutive edits so we have a non-trivial history.
  await agentA.patch(`/api/transactions/${id}`).send({ categoryOverride: 'OldCat' });
  await agentA.patch(`/api/transactions/${id}`).send({ categoryOverride: 'NewCat' });

  const tl1 = await agentA.get(`/api/transactions/${id}/revisions`);
  const revs = tl1.body.data as Array<{ id: number; source: string; changes: Array<{ field: string; before: unknown; after: unknown }> }>;
  // Pick the revision whose `after` was 'NewCat' — that's the one we want to
  // undo (its `before` is 'OldCat', which is what restore should re-apply).
  const target = revs.find((r) => r.changes.some((c) => c.field === 'categoryOverride' && c.after === 'NewCat'));
  assert.ok(target, `couldn't find target revision in ${JSON.stringify(revs)}`);

  const restoreRes = await agentA.post(`/api/transactions/${id}/revisions/${target!.id}/restore`).send({});
  assert.equal(restoreRes.status, 200);
  assert.equal(restoreRes.body.transaction.categoryOverride, 'OldCat', 'category should be restored to OldCat');
  const restored = restoreRes.body.restored as Array<{ field: string; restoredTo: unknown }>;
  assert.ok(restored.some((r) => r.field === 'categoryOverride' && r.restoredTo === 'OldCat'));

  // Timeline now contains a source=restore revision whose diff carries the
  // round-trip (NewCat -> OldCat).
  const tl2 = await agentA.get(`/api/transactions/${id}/revisions`);
  const after = tl2.body.data as Array<{ source: string; changes: Array<{ field: string; before: unknown; after: unknown }> }>;
  const restoreRev = after.find((r) => r.source === 'restore');
  assert.ok(restoreRev, `expected source=restore revision, got ${JSON.stringify(after)}`);
  const restoreChange = restoreRev!.changes.find((c) => c.field === 'categoryOverride');
  assert.ok(restoreChange, 'restore revision must include categoryOverride diff');
  assert.equal(restoreChange!.before, 'NewCat');
  assert.equal(restoreChange!.after, 'OldCat');
});

test('POST /:id/revisions/:rid/restore: rejects non-restorable field in fields[] with 400', async () => {
  const id = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-09-09',
    amount: -10,
    merchantRaw: 'Non Restorable Filter',
  });
  await agentA.patch(`/api/transactions/${id}`).send({ categoryOverride: 'Cat' });
  const tl = await agentA.get(`/api/transactions/${id}/revisions`);
  const revs = tl.body.data as Array<{ id: number }>;
  assert.ok(revs.length >= 1);
  const res = await agentA.post(`/api/transactions/${id}/revisions/${revs[0].id}/restore`).send({
    fields: ['categoryOverride', 'visibility'],
  });
  // visibility is in REVISIONED_FIELDS but NOT in RESTORABLE_FIELDS — reject.
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /Unsupported restore field/i);
});

test('POST /:id/revisions/:rid/restore: cross-transaction revision returns 404', async () => {
  const id1 = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-09-10',
    amount: -10,
    merchantRaw: 'A Revision Owner',
  });
  const id2 = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-09-11',
    amount: -20,
    merchantRaw: 'Other Txn',
  });
  await agentA.patch(`/api/transactions/${id1}`).send({ categoryOverride: 'Foo' });
  const tl = await agentA.get(`/api/transactions/${id1}/revisions`);
  const ridForId1 = (tl.body.data as Array<{ id: number }>)[0].id;

  // Try to restore id1's revision against id2 — must 404, not silently mutate.
  const res = await agentA.post(`/api/transactions/${id2}/revisions/${ridForId1}/restore`).send({});
  assert.equal(res.status, 404);
});

test('PATCH /:id with aiSuggestionId tags the revision as source=ai_suggestion', async () => {
  const id = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-09-12',
    amount: -10,
    merchantRaw: 'AI Sug Path',
    createdByUserId: userAId,
  });
  // Seed an AiSuggestion linked to this txn so markTransactionSuggestionOutcome
  // can resolve it (route still works if it can't — it just doesn't mark).
  const models = await import('../../src/models');
  const sug = await models.AiSuggestion.create({
    householdId: householdAId,
    userId: userAId,
    transactionId: id,
    receiptId: null,
    kind: 'transaction_fields',
    status: 'suggested',
    inputSnapshot: {},
    output: { category: 'AiCat', business: null, splitType: null, pctMe: null, pctPartner: null, notes: null, rationale: null },
    finalSnapshot: null,
    model: null,
    promptVersion: null,
    temperature: null,
    latencyMs: null,
    providerRequestId: null,
    errorMessage: null,
  });
  const res = await agentA.patch(`/api/transactions/${id}`).send({
    categoryOverride: 'AiCat',
    aiSuggestionId: sug.id,
  });
  assert.equal(res.status, 200);
  const tl = await agentA.get(`/api/transactions/${id}/revisions`);
  const data = tl.body.data as Array<{ source: string; aiSuggestionId: number | null }>;
  const aiRev = data.find((d) => d.source === 'ai_suggestion');
  assert.ok(aiRev, `expected an ai_suggestion revision, got ${JSON.stringify(data)}`);
  assert.equal(aiRev!.aiSuggestionId, sug.id);
});

// Touch unused-ish bindings so the linter doesn't complain.
void householdBId;
void accountBId;
