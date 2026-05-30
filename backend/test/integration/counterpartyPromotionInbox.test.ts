/**
 * Integration tests for the counterparty promotion suggestion surfaces (#373).
 *
 * Covers:
 *   - GET /api/ai/counterparty-promotions returns groups when
 *     un-linked counterparty_raw recurs >= threshold in trailing 90 days
 *   - GET /api/ai/inbox includes the counterparty_promotion items
 *   - GET /api/ai/inbox/count includes the counterparty_promotion bucket
 *   - POST /api/transactions/counterparty/promote-bulk creates a Contact
 *     and bulk-links every matching un-linked txn in the window
 *   - POST /api/ai/counterparty-promotions/:normalizedName/dismiss persists
 *     the rejection so the suggestion doesn't re-appear
 *   - Threshold is read from CashflowSettings (default 3, configurable)
 *   - Household scoping — household B suggestions don't leak to A
 *   - "Already linked" txns drop out of the suggestion's count
 *
 * Setup mirrors transactionCounterpartyPromote.test.ts.
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
let accountAId: number;
let accountBId: number;
let testDb: PgTestDb;

function isoDateNDaysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function createTxn(opts: {
  householdId: number;
  accountId: number;
  counterpartyRaw: string | null;
  counterpartyContactId?: number | null;
  date?: string;
}): Promise<number> {
  const models = await import('../../src/models');
  const row = await models.Transaction.create({
    accountId: opts.accountId,
    householdId: opts.householdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'cp-suggest-test',
    date: opts.date ?? isoDateNDaysAgo(5),
    merchantRaw: 'INTERAC E-TFR FROM ' + (opts.counterpartyRaw ?? 'UNKNOWN'),
    merchantClean: 'INTERAC E-TFR FROM ' + (opts.counterpartyRaw ?? 'UNKNOWN'),
    merchantCanonical: null,
    amount: '100.0000',
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
    myShareAmount: '100',
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
    counterpartyRaw: opts.counterpartyRaw,
    counterpartyContactId: opts.counterpartyContactId ?? null,
  });
  return row.id;
}

before(async () => {
  testDb = await setupPgTestDb('cpsuggest');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const superAgent = request.agent(app);
  const register = await superAgent.post('/api/auth/register').send({
    email: 'super-cpsuggest@example.com',
    displayName: 'Super CPSuggest',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const a = await seedHousehold('CPSuggestA', 'A Partner');
  householdAId = a.householdId;
  userAId = a.userId;
  agentA = request.agent(app);
  agentA.jar.setCookie(`cashflow_session=${a.token}; Path=/`);

  const b = await seedHousehold('CPSuggestB', 'B Partner');
  householdBId = b.householdId;
  userBId = b.userId;
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
    shortCode: 'CPSA-CHQ',
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
    shortCode: 'CPSB-CHQ',
  });
  accountBId = acctB.id;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('detector: returns suggestion when un-linked counterparty recurs >= 3 in 90 days (AC #1)', async () => {
  // 3 un-linked txns from JANE DOE for household A.
  for (let i = 0; i < 3; i++) {
    await createTxn({
      householdId: householdAId,
      accountId: accountAId,
      counterpartyRaw: 'JANE DOE',
      date: isoDateNDaysAgo(10 + i),
    });
  }
  const res = await agentA.get('/api/ai/counterparty-promotions');
  assert.equal(res.status, 200);
  const promotions = res.body.promotions as Array<{
    normalizedName: string;
    supportCount: number;
    sampleRaw: string;
    exampleTransactionIds: number[];
  }>;
  const jane = promotions.find((p) => p.normalizedName === 'jane doe');
  assert.ok(jane, 'expected a JANE DOE promotion');
  assert.equal(jane.supportCount, 3);
});

test('inbox: counterparty_promotion items appear in /api/ai/inbox', async () => {
  const res = await agentA.get('/api/ai/inbox');
  assert.equal(res.status, 200);
  const items = res.body.items as Array<{ kind: string; summary: string; output: { normalizedName: string } }>;
  const jane = items.find(
    (i) =>
      i.kind === 'counterparty_promotion' && i.output?.normalizedName === 'jane doe',
  );
  assert.ok(jane, 'expected JANE DOE in the inbox');
  assert.match(jane.summary, /promote to Contact/i);
});

test('inbox count: includes counterparty_promotion bucket', async () => {
  const res = await agentA.get('/api/ai/inbox/count');
  assert.equal(res.status, 200);
  assert.ok(res.body.byKind.counterparty_promotion >= 1);
  assert.ok(res.body.total >= 1);
});

test('bulk promote: creates one Contact and links all matching txns (AC #2)', async () => {
  // Snapshot the current set of un-linked JANE DOE txns; the existing
  // 3 above plus a 4th here. We promote them all.
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    counterpartyRaw: 'Jane DOE',
    date: isoDateNDaysAgo(2),
  });

  const res = await agentA
    .post('/api/transactions/counterparty/promote-bulk')
    .send({ normalizedName: 'jane doe' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.contact.id);
  assert.equal(res.body.contact.householdId, householdAId);
  assert.ok(res.body.linkedCount >= 4, `expected >=4 linked, got ${res.body.linkedCount}`);

  // Verify the txns now point at the contact.
  const models = await import('../../src/models');
  const linked = await models.Transaction.findAll({
    where: { householdId: householdAId, counterpartyContactId: res.body.contact.id },
  });
  assert.ok(linked.length >= 4);
});

test('detector: hides promotion after all matching txns are linked (AC #4)', async () => {
  // Right after bulk-promote, JANE DOE should drop out of the suggestion
  // list since every matching txn now has counterparty_contact_id set.
  const res = await agentA.get('/api/ai/counterparty-promotions');
  assert.equal(res.status, 200);
  const promotions = res.body.promotions as Array<{ normalizedName: string }>;
  const jane = promotions.find((p) => p.normalizedName === 'jane doe');
  assert.equal(jane, undefined, 'JANE DOE should be gone after bulk promote');
});

test('dismiss: ignored normalized name does not reappear (AC #3)', async () => {
  // Seed 3 un-linked SARAH KIM txns for household A, then dismiss.
  for (let i = 0; i < 3; i++) {
    await createTxn({
      householdId: householdAId,
      accountId: accountAId,
      counterpartyRaw: 'SARAH KIM',
      date: isoDateNDaysAgo(15 + i),
    });
  }
  const before = await agentA.get('/api/ai/counterparty-promotions');
  assert.ok(
    (before.body.promotions as Array<{ normalizedName: string }>).some(
      (p) => p.normalizedName === 'sarah kim',
    ),
    'expected sarah kim in promotions',
  );

  const dismiss = await agentA
    .post(`/api/ai/counterparty-promotions/${encodeURIComponent('sarah kim')}/dismiss`)
    .send();
  assert.equal(dismiss.status, 201);

  const afterRes = await agentA.get('/api/ai/counterparty-promotions');
  assert.equal(
    (afterRes.body.promotions as Array<{ normalizedName: string }>).find(
      (p) => p.normalizedName === 'sarah kim',
    ),
    undefined,
    'sarah kim should be hidden after dismiss',
  );
});

test('threshold: raising counterpartyPromotionThreshold suppresses below-cutoff groups (AC #5)', async () => {
  // Set threshold to 5 for user A. Seed 4 BOB JONES txns. Should NOT
  // surface; lowering back to 3 should make it surface.
  const patchHi = await agentA
    .patch('/api/settings/cashflow')
    .send({ counterpartyPromotionThreshold: 5 });
  assert.equal(patchHi.status, 200);
  assert.equal(patchHi.body.counterpartyPromotionThreshold, 5);

  for (let i = 0; i < 4; i++) {
    await createTxn({
      householdId: householdAId,
      accountId: accountAId,
      counterpartyRaw: 'BOB JONES',
      date: isoDateNDaysAgo(20 + i),
    });
  }
  const r1 = await agentA.get('/api/ai/counterparty-promotions');
  assert.equal(
    (r1.body.promotions as Array<{ normalizedName: string }>).find(
      (p) => p.normalizedName === 'bob jones',
    ),
    undefined,
    'BOB JONES should NOT surface at threshold 5 with 4 hits',
  );

  const patchLo = await agentA
    .patch('/api/settings/cashflow')
    .send({ counterpartyPromotionThreshold: 3 });
  assert.equal(patchLo.status, 200);

  const r2 = await agentA.get('/api/ai/counterparty-promotions');
  assert.ok(
    (r2.body.promotions as Array<{ normalizedName: string }>).some(
      (p) => p.normalizedName === 'bob jones',
    ),
    'BOB JONES should surface at threshold 3',
  );
});

test('threshold: 1 should be rejected by the route validator', async () => {
  const bad = await agentA
    .patch('/api/settings/cashflow')
    .send({ counterpartyPromotionThreshold: 1 });
  assert.equal(bad.status, 400);
});

test('GET /api/settings/cashflow returns counterpartyPromotionThreshold in the payload', async () => {
  const res = await agentA.get('/api/settings/cashflow');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.counterpartyPromotionThreshold, 'number');
  assert.equal(res.body.counterpartyPromotionThreshold, 3);
});

test('bulk promote: cross-household txns are not linked (no data leak)', async () => {
  // Household B seeds 3 JIMMY HENDRIX txns; A tries to bulk-promote.
  // Should result in 0 linked for A's side (no rows match in A).
  for (let i = 0; i < 3; i++) {
    await createTxn({
      householdId: householdBId,
      accountId: accountBId,
      counterpartyRaw: 'JIMMY HENDRIX',
      date: isoDateNDaysAgo(10 + i),
    });
  }
  const res = await agentA
    .post('/api/transactions/counterparty/promote-bulk')
    .send({ normalizedName: 'jimmy hendrix' });
  assert.equal(res.status, 404, JSON.stringify(res.body));
});

test('detector: cross-household scoping isolates B-only counterparties from A', async () => {
  const r = await agentA.get('/api/ai/counterparty-promotions');
  assert.equal(r.status, 200);
  const promotions = r.body.promotions as Array<{ normalizedName: string }>;
  assert.equal(
    promotions.find((p) => p.normalizedName === 'jimmy hendrix'),
    undefined,
    'A should not see B-only counterparties',
  );

  const rb = await agentB.get('/api/ai/counterparty-promotions');
  const bPromotions = rb.body.promotions as Array<{ normalizedName: string }>;
  assert.ok(
    bPromotions.some((p) => p.normalizedName === 'jimmy hendrix'),
    'B should see its own counterparty',
  );
});

test('bulk promote: rejects missing normalizedName', async () => {
  const res = await agentA
    .post('/api/transactions/counterparty/promote-bulk')
    .send({});
  assert.equal(res.status, 400);
});

test('bulk promote: explicit contactId path links to caller-household Contact', async () => {
  const models = await import('../../src/models');
  // 3 fresh un-linked PAT GREEN txns.
  for (let i = 0; i < 3; i++) {
    await createTxn({
      householdId: householdAId,
      accountId: accountAId,
      counterpartyRaw: 'PAT GREEN',
      date: isoDateNDaysAgo(25 + i),
    });
  }
  const existing = await models.Contact.create({
    householdId: householdAId,
    name: 'PAT G (manual)',
    notes: null,
  });

  const res = await agentA
    .post('/api/transactions/counterparty/promote-bulk')
    .send({ normalizedName: 'pat green', contactId: existing.id });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.contact.id, existing.id);
  assert.ok(res.body.linkedCount >= 3);
});

test('dismiss: missing normalizedName returns 400', async () => {
  const res = await agentA
    .post(`/api/ai/counterparty-promotions/${encodeURIComponent('   ')}/dismiss`)
    .send();
  assert.equal(res.status, 400);
});
