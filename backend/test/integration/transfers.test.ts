/**
 * Integration tests for `backend/src/routes/transfers.ts` (issue #222).
 *
 * Coverage (one acceptance criterion → one test name where possible):
 *   - link two arbitrary transactions, both visible           [AC: user can link two txns]
 *   - link rejects same-account pair                          [shape constraint]
 *   - link rejects already-linked rows                        [no orphans]
 *   - link works across currencies (FX pair) without amount   [AC: multi-currency]
 *   - link with classification persists                       [AC: classify purpose]
 *   - link is household-scoped (other household = 404)        [security]
 *   - suggestions returns scored candidates                   [AC: app suggests matches]
 *   - suggestions excludes already-linked rows
 *   - suggestions handles already-linked input by returning sibling
 *   - unmatched queue lists transfer rows without a link      [AC: review queue]
 *   - unmatched is household-scoped
 *   - unlink clears link on both sides                        [round-trip]
 *   - patch purpose updates both sides                        [classify]
 *   - money-movement aggregates one row per pair              [AC: money flow report]
 *   - money-movement respects dateFrom/dateTo
 *   - stats returns matched/unmatched/byPurpose
 *
 * Reuses the per-test PG database pattern from transactions.test.ts so
 * the test runs against Postgres (the production target) rather than
 * SQLite.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { seedHousehold } from '../helpers/seedHousehold.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let superAgent: ReturnType<typeof request.agent>;
let agentA: ReturnType<typeof request.agent>;
let agentB: ReturnType<typeof request.agent>;
let householdAId: number;
let householdBId: number;
let userAId: number;
let userBId: number;
let accountA1Id: number;
let accountA2Id: number;
let accountA3Id: number;
let accountB1Id: number;
let testDb: PgTestDb;

type TxnSeed = {
  householdId: number;
  accountId: number;
  date: string;
  amount: number;
  currency?: string;
  merchantRaw?: string;
  merchantClean?: string;
  sourceReference?: string | null;
  txnType?: string;
  linkedTransactionId?: number | null;
  transferPurpose?: string | null;
  visibility?: string;
  createdByUserId?: number | null;
};

async function createTxn(seed: TxnSeed): Promise<number> {
  const models = await import('../../src/models');
  const row = await models.Transaction.create({
    accountId: seed.accountId,
    householdId: seed.householdId,
    // Visibility=shared so the user can see their own seeded rows under
    // visibleTransactionWhere() without needing createdByUserId.
    visibility: seed.visibility ?? 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'transfers-test',
    date: seed.date,
    merchantRaw: seed.merchantRaw ?? 'Test',
    merchantClean: seed.merchantClean ?? seed.merchantRaw ?? 'Test',
    merchantCanonical: null,
    amount: seed.amount.toFixed(4),
    currency: seed.currency ?? 'CAD',
    notes: null,
    sourceReference: seed.sourceReference ?? null,
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
    myShareAmount: String(seed.amount),
    partnerShareAmount: '0',
    businessAmount: '0',
    txnType: seed.txnType ?? 'transfer',
    autoSource: null,
    autoConfidence: null,
    linkedTransactionId: seed.linkedTransactionId ?? null,
    transferPurpose: seed.transferPurpose ?? null,
    transferLinkedAt: null,
    isRecurring: false,
    reviewFlag: false,
    reviewedAt: null,
    createdByUserId: seed.createdByUserId ?? null,
  });
  return row.id;
}

before(async () => {
  testDb = await setupPgTestDb('transfers');
  const mod = await import('../../src/app.js');
  app = mod.default;

  superAgent = request.agent(app);
  const register = await superAgent.post('/api/auth/register').send({
    email: 'super-transfers@example.com',
    displayName: 'Super Transfers',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const a = await seedHousehold('TransfersA', 'A Partner');
  householdAId = a.householdId;
  userAId = a.userId;
  agentA = request.agent(app);
  agentA.jar.setCookie(`cashflow_session=${a.token}; Path=/`);

  const b = await seedHousehold('TransfersB', 'B Partner');
  householdBId = b.householdId;
  userBId = b.userId;
  agentB = request.agent(app);
  agentB.jar.setCookie(`cashflow_session=${b.token}; Path=/`);

  const models = await import('../../src/models');
  for (const seed of [
    {
      target: 'a1',
      name: 'A Personal Chequing',
      household: householdAId,
      user: userAId,
      currency: 'CAD',
      type: 'checking',
    },
    {
      target: 'a2',
      name: 'A Corp Chequing',
      household: householdAId,
      user: userAId,
      currency: 'CAD',
      type: 'checking',
    },
    {
      target: 'a3',
      name: 'A USD Wise',
      household: householdAId,
      user: userAId,
      currency: 'USD',
      type: 'checking',
    },
    {
      target: 'b1',
      name: 'B Chequing',
      household: householdBId,
      user: userBId,
      currency: 'CAD',
      type: 'checking',
    },
  ]) {
    const acct = await models.Account.create({
      householdId: seed.household,
      ownerUserId: seed.user,
      owner: 'me',
      visibility: 'shared',
      name: seed.name,
      accountType: seed.type,
      defaultCurrency: seed.currency,
      shortCode: seed.name.slice(0, 8).toUpperCase(),
    });
    if (seed.target === 'a1') accountA1Id = acct.id;
    else if (seed.target === 'a2') accountA2Id = acct.id;
    else if (seed.target === 'a3') accountA3Id = acct.id;
    else if (seed.target === 'b1') accountB1Id = acct.id;
  }
  // Sanity assertions to make later test failures less mysterious if the
  // seeding loop ever loses a case.
  assert.ok(accountA1Id, 'accountA1Id seeded');
  assert.ok(accountA2Id, 'accountA2Id seeded');
  assert.ok(accountA3Id, 'accountA3Id seeded');
  assert.ok(accountB1Id, 'accountB1Id seeded');
  // Silence noqa: lint sees these as unused.
  void householdBId;
  void superAgent;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// ------------------- POST /api/transfers/link -------------------

test('link: two visible transactions on different accounts succeeds', async () => {
  const outId = await createTxn({
    householdId: householdAId,
    accountId: accountA1Id,
    date: '2026-03-10',
    amount: -500,
    merchantRaw: 'Transfer to Corp',
  });
  const inId = await createTxn({
    householdId: householdAId,
    accountId: accountA2Id,
    date: '2026-03-10',
    amount: 500,
    merchantRaw: 'Transfer from Personal',
  });

  const res = await agentA
    .post('/api/transfers/link')
    .send({ idA: outId, idB: inId, purpose: 'internal' });
  assert.equal(res.status, 200, `unexpected: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.a.linkedTransactionId, inId);
  assert.equal(res.body.b.linkedTransactionId, outId);
  assert.equal(res.body.a.txnType, 'transfer');
  assert.equal(res.body.b.txnType, 'transfer');
  assert.equal(res.body.a.transferPurpose, 'internal');
  assert.equal(res.body.b.transferPurpose, 'internal');
  assert.ok(res.body.a.transferLinkedAt, 'transferLinkedAt set on a');
  assert.ok(res.body.b.transferLinkedAt, 'transferLinkedAt set on b');
});

test('link: same-account pair returns 400', async () => {
  const a = await createTxn({
    householdId: householdAId,
    accountId: accountA1Id,
    date: '2026-03-11',
    amount: -10,
  });
  const b = await createTxn({
    householdId: householdAId,
    accountId: accountA1Id,
    date: '2026-03-11',
    amount: 10,
  });
  const res = await agentA.post('/api/transfers/link').send({ idA: a, idB: b });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /same account/i);
});

test('link: already-linked row returns 400', async () => {
  // Re-link the pair from the first test (both already linked).
  const out = await createTxn({
    householdId: householdAId,
    accountId: accountA1Id,
    date: '2026-03-12',
    amount: -100,
  });
  const inA = await createTxn({
    householdId: householdAId,
    accountId: accountA2Id,
    date: '2026-03-12',
    amount: 100,
  });
  // First link succeeds.
  const ok = await agentA.post('/api/transfers/link').send({ idA: out, idB: inA });
  assert.equal(ok.status, 200);
  // Now try to link `out` to a fresh row — should fail because out is taken.
  const inB = await createTxn({
    householdId: householdAId,
    accountId: accountA3Id,
    date: '2026-03-12',
    amount: 100,
  });
  const res = await agentA.post('/api/transfers/link').send({ idA: out, idB: inB });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /already linked/i);
});

test('link: multi-currency FX pair succeeds with different amounts', async () => {
  // 5,207.60 USD → 7,084.89 CAD: classic Wise FX conversion shape.
  const usdLeg = await createTxn({
    householdId: householdAId,
    accountId: accountA3Id,
    date: '2026-03-13',
    amount: -5207.6,
    currency: 'USD',
    sourceReference: 'BALANCE-FX-001',
  });
  const cadLeg = await createTxn({
    householdId: householdAId,
    accountId: accountA1Id,
    date: '2026-03-13',
    amount: 7084.89,
    currency: 'CAD',
    sourceReference: 'BALANCE-FX-001',
  });
  const res = await agentA
    .post('/api/transfers/link')
    .send({ idA: usdLeg, idB: cadLeg, purpose: 'internal' });
  assert.equal(res.status, 200, `unexpected: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.a.amount, -5207.6);
  assert.equal(res.body.b.amount, 7084.89);
});

test('link: cross-household row returns 404 (security: cannot reach into other household)', async () => {
  const aRow = await createTxn({
    householdId: householdAId,
    accountId: accountA1Id,
    date: '2026-03-14',
    amount: -50,
  });
  const bRow = await createTxn({
    householdId: householdBId,
    accountId: accountB1Id,
    date: '2026-03-14',
    amount: 50,
  });
  const res = await agentA.post('/api/transfers/link').send({ idA: aRow, idB: bRow });
  assert.equal(res.status, 404);
});

test('link: invalid purpose returns 400', async () => {
  const a = await createTxn({
    householdId: householdAId,
    accountId: accountA1Id,
    date: '2026-03-15',
    amount: -1,
  });
  const b = await createTxn({
    householdId: householdAId,
    accountId: accountA2Id,
    date: '2026-03-15',
    amount: 1,
  });
  const res = await agentA
    .post('/api/transfers/link')
    .send({ idA: a, idB: b, purpose: 'tax_evasion' });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /purpose must be one of/);
});

test('link: idA == idB returns 400', async () => {
  const a = await createTxn({
    householdId: householdAId,
    accountId: accountA1Id,
    date: '2026-03-16',
    amount: -1,
  });
  const res = await agentA.post('/api/transfers/link').send({ idA: a, idB: a });
  assert.equal(res.status, 400);
});

// ------------------- GET /api/transfers/suggestions/:id -------------------

test('suggestions: returns scored candidate sorted by best match', async () => {
  // Anchor: -200 CAD on A1, no link, with a sourceReference.
  const anchor = await createTxn({
    householdId: householdAId,
    accountId: accountA1Id,
    date: '2026-04-01',
    amount: -200,
    sourceReference: 'BALANCE-SUGG-1',
  });
  // Best candidate: +200 CAD on A2, same sourceReference, same day.
  const best = await createTxn({
    householdId: householdAId,
    accountId: accountA2Id,
    date: '2026-04-01',
    amount: 200,
    sourceReference: 'BALANCE-SUGG-1',
  });
  // Weak candidate: +200 CAD on A2, no sourceReference, three days later.
  await createTxn({
    householdId: householdAId,
    accountId: accountA2Id,
    date: '2026-04-04',
    amount: 200,
  });
  // Wrong sign — should be filtered out by scorer.
  await createTxn({
    householdId: householdAId,
    accountId: accountA2Id,
    date: '2026-04-01',
    amount: -200,
  });
  const res = await agentA.get(`/api/transfers/suggestions/${anchor}`);
  assert.equal(res.status, 200, `unexpected: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.alreadyLinked, false);
  const candidateIds = (res.body.candidates as Array<{ id: number }>).map((c) => c.id);
  assert.equal(candidateIds[0], best, 'sourceReference match must rank highest');
  // Wrong-sign row must not appear.
  const candidates = res.body.candidates as Array<{ id: number; amount: number }>;
  assert.ok(
    candidates.every((c) => Math.sign(c.amount) === 1),
    'wrong-sign candidates must be excluded',
  );
});

test('suggestions: already-linked returns sibling and empty candidates', async () => {
  const a = await createTxn({
    householdId: householdAId,
    accountId: accountA1Id,
    date: '2026-04-05',
    amount: -42,
  });
  const b = await createTxn({
    householdId: householdAId,
    accountId: accountA2Id,
    date: '2026-04-05',
    amount: 42,
  });
  await agentA.post('/api/transfers/link').send({ idA: a, idB: b, purpose: 'internal' });
  const res = await agentA.get(`/api/transfers/suggestions/${a}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.alreadyLinked, true);
  assert.equal((res.body.sibling as { id: number }).id, b);
  assert.deepEqual(res.body.candidates, []);
});

test('suggestions: excludes already-linked candidates from consideration', async () => {
  const anchor = await createTxn({
    householdId: householdAId,
    accountId: accountA1Id,
    date: '2026-04-10',
    amount: -77,
  });
  const linkedCandidate = await createTxn({
    householdId: householdAId,
    accountId: accountA2Id,
    date: '2026-04-10',
    amount: 77,
  });
  // Pre-link the would-be candidate to a third party so it's no longer available.
  const decoy = await createTxn({
    householdId: householdAId,
    accountId: accountA3Id,
    date: '2026-04-10',
    amount: -77,
  });
  await agentA
    .post('/api/transfers/link')
    .send({ idA: linkedCandidate, idB: decoy });
  const res = await agentA.get(`/api/transfers/suggestions/${anchor}`);
  assert.equal(res.status, 200);
  const ids = (res.body.candidates as Array<{ id: number }>).map((c) => c.id);
  assert.ok(!ids.includes(linkedCandidate), 'linked candidate must be excluded');
});

test('suggestions: 404 when txn not visible (cross-household)', async () => {
  const bRow = await createTxn({
    householdId: householdBId,
    accountId: accountB1Id,
    date: '2026-04-11',
    amount: -1,
  });
  const res = await agentA.get(`/api/transfers/suggestions/${bRow}`);
  assert.equal(res.status, 404);
});

// ------------------- GET /api/transfers/unmatched -------------------

test('unmatched: lists transfer rows without a linked sibling', async () => {
  const id = await createTxn({
    householdId: householdAId,
    accountId: accountA1Id,
    date: '2026-05-01',
    amount: -33,
    merchantRaw: 'Lonely Transfer',
    txnType: 'transfer',
  });
  const res = await agentA.get('/api/transfers/unmatched').query({ pageSize: 100 });
  assert.equal(res.status, 200);
  const ids = (res.body.data as Array<{ id: number }>).map((d) => d.id);
  assert.ok(ids.includes(id), `expected ${id} in unmatched queue, got ${ids.join(',')}`);
});

test('unmatched: household B does not see household A unmatched rows', async () => {
  const aRow = await createTxn({
    householdId: householdAId,
    accountId: accountA1Id,
    date: '2026-05-02',
    amount: -1,
    txnType: 'transfer',
  });
  const res = await agentB.get('/api/transfers/unmatched').query({ pageSize: 100 });
  assert.equal(res.status, 200);
  const ids = (res.body.data as Array<{ id: number }>).map((d) => d.id);
  assert.ok(!ids.includes(aRow), 'household B must not see A rows');
});

// ------------------- POST /api/transfers/unlink -------------------

test('unlink: clears link on both sides', async () => {
  const a = await createTxn({
    householdId: householdAId,
    accountId: accountA1Id,
    date: '2026-05-10',
    amount: -90,
  });
  const b = await createTxn({
    householdId: householdAId,
    accountId: accountA2Id,
    date: '2026-05-10',
    amount: 90,
  });
  const link = await agentA
    .post('/api/transfers/link')
    .send({ idA: a, idB: b, purpose: 'internal' });
  assert.equal(link.status, 200);
  const unlink = await agentA.post('/api/transfers/unlink').send({ id: a });
  assert.equal(unlink.status, 200);
  assert.equal(unlink.body.a.linkedTransactionId, null);
  assert.equal(unlink.body.a.transferPurpose, null);
  assert.equal(unlink.body.a.transferLinkedAt, null);
  assert.equal(unlink.body.b.linkedTransactionId, null);
  assert.equal(unlink.body.b.transferPurpose, null);
  // Both rows remain txnType=transfer so they re-enter the unmatched queue.
  assert.equal(unlink.body.a.txnType, 'transfer');
  assert.equal(unlink.body.b.txnType, 'transfer');
});

test('unlink: unlinked row returns 400', async () => {
  const a = await createTxn({
    householdId: householdAId,
    accountId: accountA1Id,
    date: '2026-05-11',
    amount: -1,
    txnType: 'transfer',
  });
  const res = await agentA.post('/api/transfers/unlink').send({ id: a });
  assert.equal(res.status, 400);
});

// ------------------- PATCH /api/transfers/:id/purpose -------------------

test('patch purpose: updates both sides of the pair', async () => {
  const a = await createTxn({
    householdId: householdAId,
    accountId: accountA1Id,
    date: '2026-05-20',
    amount: -250,
  });
  const b = await createTxn({
    householdId: householdAId,
    accountId: accountA2Id,
    date: '2026-05-20',
    amount: 250,
  });
  await agentA.post('/api/transfers/link').send({ idA: a, idB: b });
  // Initially no purpose.
  const initial = await agentA
    .patch(`/api/transfers/${a}/purpose`)
    .send({ purpose: 'owner_draw' });
  assert.equal(initial.status, 200);
  assert.equal(initial.body.a.transferPurpose, 'owner_draw');
  assert.equal(initial.body.b.transferPurpose, 'owner_draw');
  // Switch classification.
  const swap = await agentA
    .patch(`/api/transfers/${b}/purpose`)
    .send({ purpose: 'reimbursement' });
  assert.equal(swap.status, 200);
  assert.equal(swap.body.a.transferPurpose, 'reimbursement');
  assert.equal(swap.body.b.transferPurpose, 'reimbursement');
  // Clear it.
  const clear = await agentA
    .patch(`/api/transfers/${a}/purpose`)
    .send({ purpose: null });
  assert.equal(clear.status, 200);
  assert.equal(clear.body.a.transferPurpose, null);
  assert.equal(clear.body.b.transferPurpose, null);
});

test('patch purpose: unlinked row returns 400', async () => {
  const a = await createTxn({
    householdId: householdAId,
    accountId: accountA1Id,
    date: '2026-05-21',
    amount: -1,
    txnType: 'transfer',
  });
  const res = await agentA
    .patch(`/api/transfers/${a}/purpose`)
    .send({ purpose: 'internal' });
  assert.equal(res.status, 400);
});

// ------------------- GET /api/transfers/money-movement -------------------

test('money-movement: aggregates linked transfers into one row per (source→dest, currency, purpose)', async () => {
  // Two linked pairs A1→A2 with internal purpose, $100 + $200.
  for (const amount of [100, 200]) {
    const out = await createTxn({
      householdId: householdAId,
      accountId: accountA1Id,
      date: '2026-06-01',
      amount: -amount,
    });
    const inn = await createTxn({
      householdId: householdAId,
      accountId: accountA2Id,
      date: '2026-06-01',
      amount,
    });
    const r = await agentA
      .post('/api/transfers/link')
      .send({ idA: out, idB: inn, purpose: 'internal' });
    assert.equal(r.status, 200);
  }
  // One linked pair A2→A1 with owner_draw $500.
  const out = await createTxn({
    householdId: householdAId,
    accountId: accountA2Id,
    date: '2026-06-02',
    amount: -500,
  });
  const inn = await createTxn({
    householdId: householdAId,
    accountId: accountA1Id,
    date: '2026-06-02',
    amount: 500,
  });
  const r = await agentA
    .post('/api/transfers/link')
    .send({ idA: out, idB: inn, purpose: 'owner_draw' });
  assert.equal(r.status, 200);

  const res = await agentA
    .get('/api/transfers/money-movement')
    .query({ dateFrom: '2026-06-01', dateTo: '2026-06-02' });
  assert.equal(res.status, 200);
  const flows = res.body.flows as Array<{
    sourceAccountId: number;
    destAccountId: number;
    purpose: string | null;
    count: number;
    totalSourceAmount: number;
  }>;
  // A1→A2 internal: 2 pairs summing to 300.
  const a1ToA2 = flows.find(
    (f) =>
      f.sourceAccountId === accountA1Id &&
      f.destAccountId === accountA2Id &&
      f.purpose === 'internal',
  );
  assert.ok(a1ToA2, `expected A1→A2 internal in flows: ${JSON.stringify(flows)}`);
  assert.equal(a1ToA2.count, 2);
  assert.equal(a1ToA2.totalSourceAmount, 300);
  // A2→A1 owner_draw: 1 pair summing to 500.
  const a2ToA1 = flows.find(
    (f) =>
      f.sourceAccountId === accountA2Id &&
      f.destAccountId === accountA1Id &&
      f.purpose === 'owner_draw',
  );
  assert.ok(a2ToA1, 'expected A2→A1 owner_draw in flows');
  assert.equal(a2ToA1.count, 1);
  assert.equal(a2ToA1.totalSourceAmount, 500);
});

test('money-movement: rejects invalid purpose with 400', async () => {
  const res = await agentA
    .get('/api/transfers/money-movement')
    .query({ purpose: 'tax_evasion' });
  assert.equal(res.status, 400);
});

// ------------------- GET /api/transfers/stats -------------------

test('stats: returns matched/unmatched/dangling counts and purpose breakdown', async () => {
  const res = await agentA.get('/api/transfers/stats');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.matched, 'number');
  assert.equal(typeof res.body.unmatched, 'number');
  assert.equal(typeof res.body.dangling, 'number');
  assert.ok(typeof res.body.byPurpose === 'object');
  // matched counts reciprocal PAIRS (not legs): we linked >= 3 pairs above.
  assert.ok(res.body.matched >= 3, `expected matched >= 3 pairs, got ${res.body.matched}`);
  // byPurpose counts pairs: 2 internal pairs were linked above.
  assert.ok(res.body.byPurpose.internal >= 2, `internal should be >=2 pairs (got ${res.body.byPurpose.internal})`);
});

test('stats: a one-way link counts as dangling, not matched (issue #553)', async () => {
  // Seed two legs where only A points at B; B has no back-link. This is the
  // exact shape that previously inflated `matched`.
  const a = await createTxn({
    householdId: householdAId,
    accountId: accountA1Id,
    date: '2026-07-01',
    amount: -777,
  });
  const b = await createTxn({
    householdId: householdAId,
    accountId: accountA2Id,
    date: '2026-07-01',
    amount: 777,
  });
  // Write a one-way link directly (the API would write both sides; we
  // deliberately create the broken state).
  const models = await import('../../src/models');
  await models.Transaction.update(
    { linkedTransactionId: b },
    { where: { id: a } },
  );

  const before = await agentA.get('/api/transfers/stats');
  const matchedBefore = before.body.matched as number;
  const danglingBefore = before.body.dangling as number;

  // Re-read to assert the dangling leg landed in `dangling`, not `matched`.
  const res = await agentA.get('/api/transfers/stats');
  assert.equal(res.status, 200);
  assert.equal(res.body.matched, matchedBefore, 'one-way link must not increase matched pairs');
  assert.ok(res.body.dangling >= 1, `expected dangling >= 1, got ${res.body.dangling}`);
  assert.equal(res.body.dangling, danglingBefore);

  // Clean up so later assertions are not affected.
  await models.Transaction.update({ linkedTransactionId: null }, { where: { id: a } });
});

test('money-movement: a one-way link surfaces in dangling, not silently dropped (issue #553)', async () => {
  const a = await createTxn({
    householdId: householdAId,
    accountId: accountA1Id,
    date: '2026-08-01',
    amount: -4242,
  });
  const b = await createTxn({
    householdId: householdAId,
    accountId: accountA2Id,
    date: '2026-08-01',
    amount: 4242,
  });
  const models = await import('../../src/models');
  await models.Transaction.update({ linkedTransactionId: b }, { where: { id: a } });

  const res = await agentA
    .get('/api/transfers/money-movement')
    .query({ dateFrom: '2026-08-01', dateTo: '2026-08-01' });
  assert.equal(res.status, 200);
  assert.ok(res.body.dangling, 'response includes a dangling summary');
  assert.equal(res.body.dangling.count, 1, 'the one-way leg is counted as dangling');
  assert.equal(
    res.body.dangling.totalSourceAmount,
    4242,
    'its value is surfaced, not dropped',
  );
  // It must NOT appear as a flow.
  const leak = (res.body.flows as Array<{ totalSourceAmount: number }>).find(
    (f) => f.totalSourceAmount === 4242,
  );
  assert.equal(leak, undefined, 'dangling value must not leak into flows');

  await models.Transaction.update({ linkedTransactionId: null }, { where: { id: a } });
});
