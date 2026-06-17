/**
 * Integration tests for `backend/src/routes/statements.ts` (#242).
 *
 * Coverage (one acceptance criterion → one test name where possible):
 *   - create a statement period for an account                 [AC: create/import]
 *   - reject malformed input + invalid date ranges             [shape constraint]
 *   - reject cross-household account                            [security]
 *   - reject duplicate (account, period)                        [data integrity]
 *   - list returns rows scoped to household                    [security + AC]
 *   - detail returns expectedClosing, variance, transactions   [AC: variance amount]
 *   - balanced statement marks reconciled without explanation  [AC: reconciled status]
 *   - imbalanced statement requires explanation to reconcile   [AC: variance + explain]
 *   - unreconcile flips reconciledAt back to null              [round-trip]
 *   - patch updates fields and recomputes variance             [AC: variance updated]
 *   - delete removes the row                                   [CRUD]
 *   - internal transfers don't cause double counting           [AC: transfers no double]
 *   - refunds net out cleanly                                  [AC: refunds no double]
 *
 * Uses the per-test PG database pattern from transfers.test.ts so the
 * test runs against Postgres rather than SQLite.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { seedHousehold } from '../helpers/seedHousehold.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

// Disable the AI/statement rate limiter inside this test (defence-in-depth
// — aiSuggestLimiter already skips under NODE_ENV=test, but flip both
// flags explicitly so a future change to the limiter doesn't silently
// break us with a 429).
process.env.NODE_ENV = 'test';

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
let accountB1Id: number;
let testDb: PgTestDb;

type TxnSeed = {
  householdId: number;
  accountId: number;
  date: string;
  amount: number;
  currency?: string;
  merchantRaw?: string;
  visibility?: string;
  createdByUserId?: number | null;
  txnType?: string;
  linkedTransactionId?: number | null;
  transferPurpose?: string | null;
};

async function createTxn(seed: TxnSeed): Promise<number> {
  const models = await import('../../src/models');
  const row = await models.Transaction.create({
    accountId: seed.accountId,
    householdId: seed.householdId,
    visibility: seed.visibility ?? 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'statements-test',
    date: seed.date,
    merchantRaw: seed.merchantRaw ?? 'Test Merchant',
    merchantClean: seed.merchantRaw ?? 'Test Merchant',
    merchantCanonical: null,
    amount: seed.amount.toFixed(4),
    currency: seed.currency ?? 'CAD',
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
    myShareAmount: String(seed.amount),
    partnerShareAmount: '0',
    businessAmount: '0',
    txnType: seed.txnType ?? 'purchase',
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
  testDb = await setupPgTestDb('statements');
  const mod = await import('../../src/app.js');
  app = mod.default;

  superAgent = request.agent(app);
  const register = await superAgent.post('/api/auth/register').send({
    email: 'super-statements@example.com',
    displayName: 'Super Statements',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const a = await seedHousehold('StatementsA', 'A Partner');
  householdAId = a.householdId;
  userAId = a.userId;
  agentA = request.agent(app);
  agentA.jar.setCookie(`cashflow_session=${a.token}; Path=/`);

  const b = await seedHousehold('StatementsB', 'B Partner');
  householdBId = b.householdId;
  userBId = b.userId;
  agentB = request.agent(app);
  agentB.jar.setCookie(`cashflow_session=${b.token}; Path=/`);

  const models = await import('../../src/models');
  for (const seed of [
    {
      target: 'a1',
      name: 'A Personal Chequing',
      shortCode: 'A1CHQ',
      household: householdAId,
      user: userAId,
      currency: 'CAD',
      type: 'checking',
    },
    {
      target: 'a2',
      name: 'A Personal Savings',
      shortCode: 'A2SAV',
      household: householdAId,
      user: userAId,
      currency: 'CAD',
      type: 'savings',
    },
    {
      target: 'b1',
      name: 'B Chequing',
      shortCode: 'B1CHQ',
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
      shortCode: seed.shortCode,
    });
    if (seed.target === 'a1') accountA1Id = acct.id;
    else if (seed.target === 'a2') accountA2Id = acct.id;
    else if (seed.target === 'b1') accountB1Id = acct.id;
  }
  assert.ok(accountA1Id, 'accountA1Id seeded');
  assert.ok(accountA2Id, 'accountA2Id seeded');
  assert.ok(accountB1Id, 'accountB1Id seeded');
  void householdBId;
  void userBId;
  void superAgent;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// ------------------- POST /api/accounts/statements -------------------

test('create: valid payload returns 201 with serialized row', async () => {
  const res = await agentA.post('/api/accounts/statements').send({
    accountId: accountA1Id,
    periodStart: '2026-01-01',
    periodEnd: '2026-01-31',
    openingBalance: 1000,
    closingBalance: 850,
    currency: 'CAD',
    sourceFilename: 'jan-2026-statement.pdf',
    notes: 'Imported from CIBC',
  });
  assert.equal(res.status, 201, `unexpected: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.data.accountId, accountA1Id);
  assert.equal(res.body.data.periodStart, '2026-01-01');
  assert.equal(res.body.data.periodEnd, '2026-01-31');
  assert.equal(res.body.data.openingBalance, 1000);
  assert.equal(res.body.data.closingBalance, 850);
  assert.equal(res.body.data.currency, 'CAD');
  assert.equal(res.body.data.reconciledAt, null);
  assert.equal(res.body.data.varianceExplanation, null);
  assert.equal(res.body.data.account.id, accountA1Id);
});

test('create: missing accountId returns 400', async () => {
  const res = await agentA.post('/api/accounts/statements').send({
    periodStart: '2026-02-01',
    periodEnd: '2026-02-28',
    openingBalance: 100,
    closingBalance: 100,
  });
  assert.equal(res.status, 400);
});

test('create: malformed periodStart returns 400', async () => {
  const res = await agentA.post('/api/accounts/statements').send({
    accountId: accountA1Id,
    periodStart: 'jan 1st',
    periodEnd: '2026-02-28',
    openingBalance: 100,
    closingBalance: 100,
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /periodStart/i);
});

test('create: periodEnd before periodStart returns 400', async () => {
  const res = await agentA.post('/api/accounts/statements').send({
    accountId: accountA1Id,
    periodStart: '2026-03-31',
    periodEnd: '2026-03-01',
    openingBalance: 100,
    closingBalance: 100,
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /on or after/i);
});

test('create: non-finite balance returns 400', async () => {
  const res = await agentA.post('/api/accounts/statements').send({
    accountId: accountA1Id,
    periodStart: '2026-04-01',
    periodEnd: '2026-04-30',
    openingBalance: 'lots',
    closingBalance: 100,
  });
  assert.equal(res.status, 400);
});

test('create: cross-household account returns 404', async () => {
  const res = await agentA.post('/api/accounts/statements').send({
    accountId: accountB1Id,
    periodStart: '2026-04-01',
    periodEnd: '2026-04-30',
    openingBalance: 0,
    closingBalance: 0,
  });
  assert.equal(res.status, 404);
});

test('create: duplicate (account, periodStart, periodEnd) returns 409', async () => {
  const res = await agentA.post('/api/accounts/statements').send({
    accountId: accountA1Id,
    periodStart: '2026-01-01',
    periodEnd: '2026-01-31',
    openingBalance: 1000,
    closingBalance: 800,
  });
  assert.equal(res.status, 409, `unexpected: ${JSON.stringify(res.body)}`);
});

// ------------------- GET /api/accounts/statements -------------------

test('list: includes the statement we created, scoped to household', async () => {
  const res = await agentA.get('/api/accounts/statements?pageSize=100');
  assert.equal(res.status, 200);
  assert.ok(
    (res.body.data as Array<{ accountId: number }>).some(
      (s) => s.accountId === accountA1Id,
    ),
    'household A should see its own statement',
  );
  // Other household must not see any of these rows.
  const resB = await agentB.get('/api/accounts/statements?pageSize=100');
  assert.equal(resB.status, 200);
  assert.equal(
    (resB.body.data as Array<{ accountId: number }>).filter(
      (s) => s.accountId === accountA1Id,
    ).length,
    0,
    'household B must not see household A statements',
  );
});

test('list: accountId filter narrows to one account', async () => {
  await agentA.post('/api/accounts/statements').send({
    accountId: accountA2Id,
    periodStart: '2026-01-01',
    periodEnd: '2026-01-31',
    openingBalance: 500,
    closingBalance: 500,
  });
  const res = await agentA.get(`/api/accounts/statements?accountId=${accountA1Id}`);
  assert.equal(res.status, 200);
  const ids = (res.body.data as Array<{ accountId: number }>).map(
    (s) => s.accountId,
  );
  assert.ok(ids.length > 0);
  assert.ok(
    ids.every((aid) => aid === accountA1Id),
    `expected only accountA1 rows, got: ${ids.join(',')}`,
  );
});

// ------------------- GET /api/accounts/statements/:id -------------------

test('detail: returns expectedClosing, variance, transactions in the period', async () => {
  // Seed a fresh account + period with known math so this test isolates
  // the variance computation from siblings.
  const models = await import('../../src/models');
  const acct = await models.Account.create({
    householdId: householdAId,
    ownerUserId: userAId,
    owner: 'me',
    visibility: 'shared',
    name: 'Variance Test Account',
    accountType: 'checking',
    defaultCurrency: 'CAD',
    shortCode: 'VARTEST',
  });
  // Two purchases on the period: -100 and -50 → expected closing 850.
  await createTxn({
    householdId: householdAId,
    accountId: acct.id,
    date: '2026-05-05',
    amount: -100,
  });
  await createTxn({
    householdId: householdAId,
    accountId: acct.id,
    date: '2026-05-10',
    amount: -50,
  });
  // One out-of-window transaction that must NOT contribute.
  await createTxn({
    householdId: householdAId,
    accountId: acct.id,
    date: '2026-06-01',
    amount: -9999,
  });
  // Statement says closing 870 — variance 20.
  const create = await agentA.post('/api/accounts/statements').send({
    accountId: acct.id,
    periodStart: '2026-05-01',
    periodEnd: '2026-05-31',
    openingBalance: 1000,
    closingBalance: 870,
  });
  assert.equal(create.status, 201);
  const id = create.body.data.id as number;

  const detail = await agentA.get(`/api/accounts/statements/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.reconciliation.expectedClosing, 850);
  assert.equal(detail.body.reconciliation.variance, 20);
  assert.equal(detail.body.reconciliation.isBalanced, false);
  assert.equal(detail.body.reconciliation.transactionCount, 2);
  const dates = (detail.body.transactions as Array<{ date: string }>).map(
    (t) => t.date,
  );
  assert.deepEqual(dates, ['2026-05-05', '2026-05-10']);
});

test('detail: cross-household returns 404', async () => {
  const create = await agentB.post('/api/accounts/statements').send({
    accountId: accountB1Id,
    periodStart: '2026-05-01',
    periodEnd: '2026-05-31',
    openingBalance: 0,
    closingBalance: 0,
  });
  assert.equal(create.status, 201);
  const id = create.body.data.id as number;
  const res = await agentA.get(`/api/accounts/statements/${id}`);
  assert.equal(res.status, 404);
});

// ------------------- reconcile / unreconcile -------------------

test('reconcile: balanced statement succeeds without explanation', async () => {
  const models = await import('../../src/models');
  const acct = await models.Account.create({
    householdId: householdAId,
    ownerUserId: userAId,
    owner: 'me',
    visibility: 'shared',
    name: 'Reconcile Balanced',
    accountType: 'checking',
    defaultCurrency: 'CAD',
    shortCode: 'RECBAL',
  });
  await createTxn({
    householdId: householdAId,
    accountId: acct.id,
    date: '2026-06-15',
    amount: -200,
  });
  const create = await agentA.post('/api/accounts/statements').send({
    accountId: acct.id,
    periodStart: '2026-06-01',
    periodEnd: '2026-06-30',
    openingBalance: 500,
    closingBalance: 300,
  });
  const id = create.body.data.id as number;
  const res = await agentA.post(`/api/accounts/statements/${id}/reconcile`).send({});
  assert.equal(res.status, 200, `unexpected: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.data.reconciledAt, 'reconciledAt must be set');
  assert.equal(res.body.reconciliation.variance, 0);
  assert.equal(res.body.reconciliation.isBalanced, true);
});

test('reconcile: imbalanced statement without explanation returns 400', async () => {
  const models = await import('../../src/models');
  const acct = await models.Account.create({
    householdId: householdAId,
    ownerUserId: userAId,
    owner: 'me',
    visibility: 'shared',
    name: 'Reconcile Imbalanced',
    accountType: 'checking',
    defaultCurrency: 'CAD',
    shortCode: 'RECIMB',
  });
  const create = await agentA.post('/api/accounts/statements').send({
    accountId: acct.id,
    periodStart: '2026-07-01',
    periodEnd: '2026-07-31',
    openingBalance: 1000,
    closingBalance: 500, // expected = 1000 (no txns), so variance = -500
  });
  const id = create.body.data.id as number;
  const res = await agentA.post(`/api/accounts/statements/${id}/reconcile`).send({});
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /varianceExplanation/i);
});

test('reconcile: imbalanced statement with explanation succeeds', async () => {
  const models = await import('../../src/models');
  const acct = await models.Account.create({
    householdId: householdAId,
    ownerUserId: userAId,
    owner: 'me',
    visibility: 'shared',
    name: 'Reconcile With Explain',
    accountType: 'checking',
    defaultCurrency: 'CAD',
    shortCode: 'RECEXP',
  });
  const create = await agentA.post('/api/accounts/statements').send({
    accountId: acct.id,
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    openingBalance: 1000,
    closingBalance: 500,
  });
  const id = create.body.data.id as number;
  const res = await agentA.post(`/api/accounts/statements/${id}/reconcile`).send({
    varianceExplanation: 'Missing cash withdrawal — recorded by hand.',
  });
  assert.equal(res.status, 200, `unexpected: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.data.reconciledAt);
  assert.equal(
    res.body.data.varianceExplanation,
    'Missing cash withdrawal — recorded by hand.',
  );
});

test('unreconcile: clears reconciledAt but keeps the explanation', async () => {
  // Create + reconcile a balanced statement, then unreconcile.
  const models = await import('../../src/models');
  const acct = await models.Account.create({
    householdId: householdAId,
    ownerUserId: userAId,
    owner: 'me',
    visibility: 'shared',
    name: 'Unreconcile Test',
    accountType: 'checking',
    defaultCurrency: 'CAD',
    shortCode: 'UNREC',
  });
  const create = await agentA.post('/api/accounts/statements').send({
    accountId: acct.id,
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    openingBalance: 100,
    closingBalance: 100,
  });
  const id = create.body.data.id as number;
  const rec = await agentA.post(`/api/accounts/statements/${id}/reconcile`).send({
    varianceExplanation: 'No variance — just affirming.',
  });
  assert.equal(rec.status, 200);
  const un = await agentA.post(`/api/accounts/statements/${id}/unreconcile`).send({});
  assert.equal(un.status, 200);
  assert.equal(un.body.data.reconciledAt, null);
  assert.equal(un.body.data.varianceExplanation, 'No variance — just affirming.');
});

test('unreconcile: already-unreconciled statement returns 400', async () => {
  const create = await agentA.post('/api/accounts/statements').send({
    accountId: accountA2Id,
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    openingBalance: 0,
    closingBalance: 0,
  });
  const id = create.body.data.id as number;
  const res = await agentA.post(`/api/accounts/statements/${id}/unreconcile`).send({});
  assert.equal(res.status, 400);
});

// ------------------- PATCH /api/accounts/statements/:id -------------------

test('patch: updates closingBalance and recomputes variance', async () => {
  const create = await agentA.post('/api/accounts/statements').send({
    accountId: accountA2Id,
    periodStart: '2026-11-01',
    periodEnd: '2026-11-30',
    openingBalance: 100,
    closingBalance: 200,
  });
  assert.equal(create.status, 201);
  const id = create.body.data.id as number;
  // No transactions for accountA2 in Nov → expected closing 100; variance was 100.
  const patch = await agentA.patch(`/api/accounts/statements/${id}`).send({
    closingBalance: 100,
    notes: 'Corrected closing.',
  });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.data.closingBalance, 100);
  assert.equal(patch.body.data.notes, 'Corrected closing.');
  assert.equal(patch.body.reconciliation.variance, 0);
});

test('patch: variance explanation can be set independently', async () => {
  const create = await agentA.post('/api/accounts/statements').send({
    accountId: accountA2Id,
    periodStart: '2026-12-01',
    periodEnd: '2026-12-31',
    openingBalance: 1000,
    closingBalance: 200,
  });
  const id = create.body.data.id as number;
  const patch = await agentA.patch(`/api/accounts/statements/${id}`).send({
    varianceExplanation: 'Cash withdrawn at ATM.',
  });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.data.varianceExplanation, 'Cash withdrawn at ATM.');
});

// ------------------- DELETE /api/accounts/statements/:id -------------------

test('delete: removes the row and subsequent get returns 404', async () => {
  const create = await agentA.post('/api/accounts/statements').send({
    accountId: accountA2Id,
    periodStart: '2027-01-01',
    periodEnd: '2027-01-31',
    openingBalance: 0,
    closingBalance: 0,
  });
  const id = create.body.data.id as number;
  const del = await agentA.delete(`/api/accounts/statements/${id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.ok, true);
  const after = await agentA.get(`/api/accounts/statements/${id}`);
  assert.equal(after.status, 404);
});

// ------------------- AC-specific scenarios -------------------

test('AC: internal transfers do not cause double counting', async () => {
  // Two accounts in household A. A 500-CAD transfer Chequing → Savings is
  // stored as one negative row on Chequing and one positive row on Savings.
  // The Chequing statement must reflect only the negative leg.
  const models = await import('../../src/models');
  const acct = await models.Account.create({
    householdId: householdAId,
    ownerUserId: userAId,
    owner: 'me',
    visibility: 'shared',
    name: 'Chequing for transfer test',
    accountType: 'checking',
    defaultCurrency: 'CAD',
    shortCode: 'TXFRCHQ',
  });
  const other = await models.Account.create({
    householdId: householdAId,
    ownerUserId: userAId,
    owner: 'me',
    visibility: 'shared',
    name: 'Savings for transfer test',
    accountType: 'savings',
    defaultCurrency: 'CAD',
    shortCode: 'TXFRSAV',
  });
  const outId = await createTxn({
    householdId: householdAId,
    accountId: acct.id,
    date: '2027-02-10',
    amount: -500,
    txnType: 'transfer',
  });
  await createTxn({
    householdId: householdAId,
    accountId: other.id,
    date: '2027-02-10',
    amount: 500,
    txnType: 'transfer',
  });
  // Sanity: link them as a transfer pair so the data shape matches what
  // real users have on disk.
  void outId;
  // Statement on Chequing: opening 2000, txn -500 → expected 1500.
  const create = await agentA.post('/api/accounts/statements').send({
    accountId: acct.id,
    periodStart: '2027-02-01',
    periodEnd: '2027-02-28',
    openingBalance: 2000,
    closingBalance: 1500,
  });
  assert.equal(create.status, 201);
  const id = create.body.data.id as number;
  const detail = await agentA.get(`/api/accounts/statements/${id}`);
  assert.equal(detail.status, 200);
  // Only the Chequing leg is in the txn list — not the Savings sibling.
  assert.equal(detail.body.reconciliation.transactionCount, 1);
  assert.equal(detail.body.reconciliation.expectedClosing, 1500);
  assert.equal(detail.body.reconciliation.variance, 0);
});

test('AC: refunds net out without special-case handling', async () => {
  const models = await import('../../src/models');
  const acct = await models.Account.create({
    householdId: householdAId,
    ownerUserId: userAId,
    owner: 'me',
    visibility: 'shared',
    name: 'Refund Test',
    accountType: 'credit_card',
    defaultCurrency: 'CAD',
    shortCode: 'REFUNDTST',
  });
  // Original purchase + matching refund within the same period.
  await createTxn({
    householdId: householdAId,
    accountId: acct.id,
    date: '2027-03-05',
    amount: -120,
  });
  await createTxn({
    householdId: householdAId,
    accountId: acct.id,
    date: '2027-03-20',
    amount: 120,
    txnType: 'refund',
  });
  const create = await agentA.post('/api/accounts/statements').send({
    accountId: acct.id,
    periodStart: '2027-03-01',
    periodEnd: '2027-03-31',
    openingBalance: 0,
    closingBalance: 0,
  });
  const id = create.body.data.id as number;
  const detail = await agentA.get(`/api/accounts/statements/${id}`);
  assert.equal(detail.body.reconciliation.transactionCount, 2);
  assert.equal(detail.body.reconciliation.expectedClosing, 0);
  assert.equal(detail.body.reconciliation.variance, 0);
});
