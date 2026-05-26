/**
 * Integration tests for `backend/src/routes/transactions.ts`:
 *   - GET /api/transactions  (buildTransactionFilterWhere, pagination, receiptCount)
 *   - PATCH /api/transactions/:id  (auth, applyPatchBody side effects)
 *   - POST /api/transactions/bulk-patch-filter  (write isolation, cap)
 *   - GET /api/transactions/enrichment/stats
 *
 * Setup mirrors `summary.test.ts`: an isolated SQLite DB, a bootstrap
 * superadmin, and two non-superadmin households (A and B) seeded via
 * the shared `seedHousehold` helper. Transactions are written directly
 * with `Transaction.create` for tight control over fixture state.
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
let contactAId: number;
let contactBId: number;
let accountAId: number;
let accountBId: number;
let testDb: PgTestDb;

type TxnSeed = {
  householdId: number;
  accountId: number;
  date: string;
  amount: number;
  currency?: string;
  merchantRaw?: string;
  merchantClean?: string;
  merchantCanonical?: string | null;
  finalCategory?: string | null;
  finalBusiness?: boolean;
  finalSplitType?: string;
  ownershipType?: string;
  ownershipContactId?: number | null;
  myShareAmount?: number;
  partnerShareAmount?: number;
  businessAmount?: number;
  txnType?: string;
  reviewFlag?: boolean;
  visibility?: string;
  createdByUserId?: number | null;
  importBatch?: string;
};

async function createTxn(seed: TxnSeed): Promise<number> {
  const models = await import('../../src/models');
  const row = await models.Transaction.create({
    accountId: seed.accountId,
    householdId: seed.householdId,
    visibility: seed.visibility ?? 'shared',
    ownershipType: seed.ownershipType ?? 'me',
    ownershipContactId: seed.ownershipContactId ?? null,
    importBatch: seed.importBatch ?? 'transactions-test',
    date: seed.date,
    merchantRaw: seed.merchantRaw ?? 'Test Merchant',
    merchantClean: seed.merchantClean ?? seed.merchantRaw ?? 'Test Merchant',
    merchantCanonical: seed.merchantCanonical ?? null,
    amount: seed.amount.toFixed(4),
    currency: seed.currency ?? 'CAD',
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
    finalBusiness: seed.finalBusiness ?? false,
    autoSplitType: null,
    splitOverride: null,
    finalSplitType: seed.finalSplitType ?? 'me',
    autoPctMe: null,
    pctMeOverride: null,
    finalPctMe: null,
    autoPctPartner: null,
    pctPartnerOverride: null,
    finalPctPartner: null,
    myShareAmount: String(seed.myShareAmount ?? seed.amount),
    partnerShareAmount: String(seed.partnerShareAmount ?? 0),
    businessAmount: String(seed.businessAmount ?? 0),
    txnType: seed.txnType ?? 'purchase',
    autoSource: null,
    autoConfidence: null,
    linkedTransactionId: null,
    isRecurring: false,
    reviewFlag: seed.reviewFlag ?? false,
    reviewedAt: null,
    createdByUserId: seed.createdByUserId ?? null,
  });
  return row.id;
}

before(async () => {
  testDb = await setupPgTestDb('transactions');

  const mod = await import('../../src/app.js');
  app = mod.default;

  superAgent = request.agent(app);
  const register = await superAgent.post('/api/auth/register').send({
    email: 'super-txns@example.com',
    displayName: 'Super Txns',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const a = await seedHousehold('TxnsA', 'A Partner');
  householdAId = a.householdId;
  userAId = a.userId;
  contactAId = a.contactId;
  agentA = request.agent(app);
  agentA.jar.setCookie(`cashflow_session=${a.token}; Path=/`);

  const b = await seedHousehold('TxnsB', 'B Partner');
  householdBId = b.householdId;
  userBId = b.userId;
  contactBId = b.contactId;
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
    ownerUserId: userBId,
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

// ---------------- buildTransactionFilterWhere risk surface ----------------

test('GET /: ?ids= (empty or all-invalid) returns 200 with empty data, NEVER unfiltered', async () => {
  // Pre-seed something so an unfiltered query would NOT be empty.
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-02-01',
    amount: -10,
    merchantRaw: 'Should Not Appear For ids=,,,',
  });

  // ?ids=,,, parses to []; route turns that into where.id=-1 which matches nothing.
  // This protects a security property: "selected nothing" must never become "selected everything".
  const res = await agentA.get('/api/transactions').query({ ids: ',,,' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, [], 'ids=,,, must return zero rows');
  assert.equal(res.body.total, 0);

  // Sanity-check: omit ?ids= entirely → the row we just seeded IS visible.
  const all = await agentA.get('/api/transactions').query({ pageSize: 100 });
  assert.equal(all.status, 200);
  assert.ok((all.body.data as unknown[]).length >= 1, 'unfiltered listing should show seeded rows');
});

test('GET /: ?reviewFlag=true and =false (string) filter correctly', async () => {
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-02-02',
    amount: -11,
    merchantRaw: 'Flagged',
    reviewFlag: true,
  });
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-02-03',
    amount: -12,
    merchantRaw: 'NotFlagged',
    reviewFlag: false,
  });

  const flagged = await agentA
    .get('/api/transactions')
    .query({ reviewFlag: 'true', pageSize: 100 });
  assert.equal(flagged.status, 200);
  const flaggedRows = flagged.body.data as Array<{ merchantClean: string; reviewFlag: boolean }>;
  assert.ok(flaggedRows.every((r) => r.reviewFlag === true), 'every row must have reviewFlag=true');
  assert.ok(flaggedRows.some((r) => r.merchantClean === 'Flagged'));
  assert.ok(!flaggedRows.some((r) => r.merchantClean === 'NotFlagged'));

  const notFlagged = await agentA
    .get('/api/transactions')
    .query({ reviewFlag: 'false', pageSize: 100 });
  assert.equal(notFlagged.status, 200);
  const notFlaggedRows = notFlagged.body.data as Array<{ merchantClean: string; reviewFlag: boolean }>;
  assert.ok(notFlaggedRows.every((r) => r.reviewFlag === false));
  assert.ok(notFlaggedRows.some((r) => r.merchantClean === 'NotFlagged'));
  assert.ok(!notFlaggedRows.some((r) => r.merchantClean === 'Flagged'));
});

test('GET /: ?accountId=abc (NaN) documents current 500 (real bug — see PR body)', async () => {
  // CURRENT BEHAVIOR (BUG): parseInt('abc', 10) is NaN; the route does
  // `where.accountId = parseInt(String(source.accountId), 10)`, which then
  // makes Sequelize emit `WHERE account_id = NaN`, and SQLite responds
  // with `no such column: NaN` → 500.
  //
  // FOLLOW-UP NEEDED: `buildTransactionFilterWhere` should either drop
  // NaN-parsed numeric query params or 400 on them, mirroring the way
  // /bulk-ai-suggest / /bulk-patch reject non-integer ids.
  //
  // Until that fix, this test pins the current behavior so the bug is
  // visible to anyone reading the suite.
  const res = await agentA.get('/api/transactions').query({ accountId: 'abc' });
  assert.equal(
    res.status,
    500,
    `Expected the documented 500 from NaN coercion — if you got ${res.status}, the bug may have been fixed; flip this test to assert 200/[]`,
  );
});

test('GET /: ?dateFrom= (empty string) is ignored and returns all rows', async () => {
  // Truthiness check in buildTransactionFilterWhere drops empty-string dateFrom.
  const all = await agentA.get('/api/transactions').query({ pageSize: 100 });
  const empty = await agentA.get('/api/transactions').query({ dateFrom: '', pageSize: 100 });
  assert.equal(all.status, 200);
  assert.equal(empty.status, 200);
  assert.equal(
    (empty.body.data as unknown[]).length,
    (all.body.data as unknown[]).length,
    'empty-string dateFrom must not filter',
  );
});

test('GET /: ?dateFrom=null (literal string) is rejected with 400', async () => {
  // Route validates dateFrom/dateTo before they reach Sequelize. Junk strings
  // like "null" fail `new Date(s)` (NaN), so the route responds 400 rather
  // than letting Postgres reject the bad input with a 500.
  const res = await agentA.get('/api/transactions').query({ dateFrom: 'null' });
  assert.equal(res.status, 400, `unexpected status ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.error, 'invalid dateFrom');

  const toRes = await agentA.get('/api/transactions').query({ dateTo: 'null' });
  assert.equal(toRes.status, 400);
  assert.equal(toRes.body.error, 'invalid dateTo');
});

// ---------------- Pagination ----------------

test('GET /: ?page=0 clamps to page 1', async () => {
  const p0 = await agentA.get('/api/transactions').query({ page: 0, pageSize: 5 });
  const p1 = await agentA.get('/api/transactions').query({ page: 1, pageSize: 5 });
  assert.equal(p0.status, 200);
  assert.equal(p1.status, 200);
  assert.equal(p0.body.page, 1, 'page=0 must clamp to 1');
  assert.deepEqual(
    (p0.body.data as Array<{ id: number }>).map((r) => r.id),
    (p1.body.data as Array<{ id: number }>).map((r) => r.id),
    'page=0 results must equal page=1 results',
  );
});

test('GET /: ?pageSize=200 clamps to 100 (insert 150 rows, assert exactly 100 returned)', async () => {
  // Seed 150 fresh rows to ensure the pageSize cap is the binding limit.
  const models = await import('../../src/models');
  const created = await models.Transaction.bulkCreate(
    Array.from({ length: 150 }, (_, i) => ({
      accountId: accountAId,
      householdId: householdAId,
      visibility: 'shared',
      ownershipType: 'me',
      importBatch: 'pagination-cap-batch',
      date: '2026-03-01',
      merchantRaw: `Pagination Row ${i}`,
      merchantClean: `Pagination Row ${i}`,
      amount: '-1.0000',
      currency: 'CAD',
      sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
      sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
      finalSplitType: 'me',
      finalBusiness: false,
      myShareAmount: '-1',
      partnerShareAmount: '0',
      businessAmount: '0',
      txnType: 'purchase',
      isRecurring: false,
      reviewFlag: false,
    })),
  );
  assert.equal(created.length, 150);
  const res = await agentA
    .get('/api/transactions')
    .query({ pageSize: 200, importBatch: 'pagination-cap-batch' });
  assert.equal(res.status, 200);
  assert.equal(res.body.pageSize, 100, 'pageSize=200 must clamp to 100');
  assert.equal(
    (res.body.data as unknown[]).length,
    100,
    'data length must respect the 100 cap even with 150 matching rows',
  );
});

test('GET /: last-page calculation — 5 rows, pageSize=2, page=3 → data.length=1, total=5', async () => {
  // Fresh batch for this specific test so total is exactly 5.
  const batch = 'last-page-batch';
  const models = await import('../../src/models');
  await models.Transaction.bulkCreate(
    Array.from({ length: 5 }, (_, i) => ({
      accountId: accountAId,
      householdId: householdAId,
      visibility: 'shared',
      ownershipType: 'me',
      importBatch: batch,
      date: `2026-04-0${i + 1}`,
      merchantRaw: `LP ${i}`,
      merchantClean: `LP ${i}`,
      amount: '-2.0000',
      currency: 'CAD',
      sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
      sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
      finalSplitType: 'me',
      finalBusiness: false,
      myShareAmount: '-2',
      partnerShareAmount: '0',
      businessAmount: '0',
      txnType: 'purchase',
      isRecurring: false,
      reviewFlag: false,
    })),
  );
  const res = await agentA
    .get('/api/transactions')
    .query({ importBatch: batch, page: 3, pageSize: 2 });
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 5);
  assert.equal(res.body.page, 3);
  assert.equal((res.body.data as unknown[]).length, 1, 'last page must contain 1 row');
});

// ---------------- Receipt count map ----------------

test('GET /: row with 0 receipts gets receiptCount:0', async () => {
  const id = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-05-01',
    amount: -3,
    merchantRaw: 'No Receipts',
    importBatch: 'receipts-none-batch',
  });
  const res = await agentA
    .get('/api/transactions')
    .query({ importBatch: 'receipts-none-batch' });
  assert.equal(res.status, 200);
  const row = (res.body.data as Array<{ id: number; receiptCount: number }>).find(
    (r) => r.id === id,
  );
  assert.ok(row);
  assert.equal(row.receiptCount, 0, 'unattached row must show receiptCount=0');
});

test('GET /: row with 2 receipts gets receiptCount:2', async () => {
  const id = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-05-02',
    amount: -4,
    merchantRaw: 'Two Receipts',
    importBatch: 'receipts-two-batch',
  });
  const models = await import('../../src/models');
  for (let i = 0; i < 2; i++) {
    await models.Receipt.create({
      transactionId: id,
      storedFilename: `r${i}.pdf`,
      originalName: `r${i}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 100,
      extractedNote: null,
    });
  }
  const res = await agentA
    .get('/api/transactions')
    .query({ importBatch: 'receipts-two-batch' });
  assert.equal(res.status, 200);
  const row = (res.body.data as Array<{ id: number; receiptCount: number }>).find(
    (r) => r.id === id,
  );
  assert.ok(row);
  assert.equal(row.receiptCount, 2, 'expected receiptCount=2');
});

// ---------------- PATCH /:id ----------------

test('PATCH /:id: cross-household row returns 404', async () => {
  // Create a row in household A, try to patch it as household B.
  const id = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-06-01',
    amount: -50,
    merchantRaw: 'Only Visible To A',
  });
  const res = await agentB.patch(`/api/transactions/${id}`).send({
    categoryOverride: 'Hacked',
  });
  assert.equal(res.status, 404);
});

test('PATCH /:id: ownershipType=contact without ownershipContactId throws 400', async () => {
  const id = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-06-02',
    amount: -10,
    merchantRaw: 'Contact Without Id',
  });
  const res = await agentA.patch(`/api/transactions/${id}`).send({
    ownershipType: 'contact',
    // intentionally omit ownershipContactId
  });
  assert.equal(res.status, 400);
});

test('PATCH /:id: ownershipType=contact with cross-household contactId throws 400', async () => {
  const id = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-06-03',
    amount: -10,
    merchantRaw: 'Foreign Contact',
  });
  // Try to assign household B's contact to household A's transaction.
  const res = await agentA.patch(`/api/transactions/${id}`).send({
    ownershipType: 'contact',
    ownershipContactId: contactBId,
  });
  assert.equal(res.status, 400);
});

test('PATCH /:id: ownershipType=me clears ownershipContactId to null (even when body omits it)', async () => {
  // Seed with a valid contact-shared transaction first.
  const id = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-06-04',
    amount: -10,
    merchantRaw: 'Switch To Me',
    finalSplitType: 'shared',
    ownershipType: 'contact',
    ownershipContactId: contactAId,
  });
  const res = await agentA.patch(`/api/transactions/${id}`).send({
    ownershipType: 'me',
    // Body intentionally omits ownershipContactId — applyPatchBody nulls it
    // because final ownershipType !== 'contact'.
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ownershipType, 'me');
  assert.equal(res.body.ownershipContactId, null, 'contactId must be auto-nulled');
});

test('PATCH /:id: reviewFlag=false sets reviewedAt to a non-null timestamp', async () => {
  const id = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-06-05',
    amount: -10,
    merchantRaw: 'Review Toggle',
    reviewFlag: true,
  });
  const res = await agentA.patch(`/api/transactions/${id}`).send({ reviewFlag: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.reviewFlag, false);
  assert.ok(res.body.reviewedAt, `reviewedAt must be set, got ${res.body.reviewedAt}`);
  // Sanity: it should be a valid date.
  assert.ok(!Number.isNaN(Date.parse(String(res.body.reviewedAt))));
});

test("PATCH /:id: visibility='public' (unknown) is coerced to 'private'", async () => {
  const id = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-06-06',
    amount: -10,
    merchantRaw: 'Vis Coerce',
    visibility: 'shared',
  });
  const res = await agentA.patch(`/api/transactions/${id}`).send({ visibility: 'public' });
  assert.equal(res.status, 200);
  assert.equal(
    res.body.visibility,
    'private',
    'visibility !== "shared" must coerce to private (not pass through)',
  );
});

// ---------------- POST /bulk-patch-filter ----------------

test('POST /bulk-patch-filter: household B touches zero of household A rows', async () => {
  // Seed two readily-identified rows in household A with a unique category.
  const aIds = [
    await createTxn({
      householdId: householdAId,
      accountId: accountAId,
      date: '2026-07-01',
      amount: -5,
      finalCategory: 'XSecretCat',
      merchantRaw: 'AOnly1',
    }),
    await createTxn({
      householdId: householdAId,
      accountId: accountAId,
      date: '2026-07-02',
      amount: -6,
      finalCategory: 'XSecretCat',
      merchantRaw: 'AOnly2',
    }),
  ];

  const res = await agentB.post('/api/transactions/bulk-patch-filter').send({
    filter: { category: 'XSecretCat' },
    patch: { businessOverride: true },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.updated, 0, 'household B must not touch household A rows');

  // Verify household A's rows are untouched.
  const check = await agentA.get('/api/transactions').query({ category: 'XSecretCat' });
  assert.equal(check.status, 200);
  const rows = check.body.data as Array<{ id: number; finalBusiness: boolean }>;
  assert.equal(rows.length, aIds.length);
  for (const row of rows) {
    assert.equal(row.finalBusiness, false, 'household A row must not have been business-flagged');
  }
});

test('POST /bulk-patch-filter: >1000 matched rows returns 422 with matched/max/error, no writes', async () => {
  // Seed 1001 rows under a unique importBatch so the filter matches exactly that set.
  const batch = 'cap-batch';
  const models = await import('../../src/models');
  await models.Transaction.bulkCreate(
    Array.from({ length: 1001 }, (_, i) => ({
      accountId: accountAId,
      householdId: householdAId,
      visibility: 'shared',
      ownershipType: 'me',
      importBatch: batch,
      date: '2026-08-01',
      merchantRaw: `Cap ${i}`,
      merchantClean: `Cap ${i}`,
      amount: '-0.0100',
      currency: 'CAD',
      sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
      sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
      finalSplitType: 'me',
      finalBusiness: false,
      myShareAmount: '-0.01',
      partnerShareAmount: '0',
      businessAmount: '0',
      txnType: 'purchase',
      isRecurring: false,
      reviewFlag: false,
    })),
  );
  const res = await agentA.post('/api/transactions/bulk-patch-filter').send({
    filter: { importBatch: batch },
    patch: { categoryOverride: 'Should Not Apply' },
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.matched, 1001);
  assert.equal(res.body.max, 1000);
  assert.ok(typeof res.body.error === 'string' && res.body.error.length > 0);

  // No writes: count the patched-category rows from this batch.
  const matched = await models.Transaction.count({
    where: { importBatch: batch, finalCategory: 'Should Not Apply' },
  });
  assert.equal(matched, 0, '422 response must not have written any rows');
});

// ---------------- Filter combinatorics ----------------

test('GET /: category + dateFrom compound filter returns only in-range matching row', async () => {
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-09-01',
    amount: -10,
    finalCategory: 'CompCat',
    merchantRaw: 'In Range',
  });
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-08-31',
    amount: -10,
    finalCategory: 'CompCat',
    merchantRaw: 'Out Of Range',
  });
  const res = await agentA
    .get('/api/transactions')
    .query({ category: 'CompCat', dateFrom: '2026-09-01' });
  assert.equal(res.status, 200);
  const merchants = (res.body.data as Array<{ merchantClean: string }>).map((r) => r.merchantClean);
  assert.ok(merchants.includes('In Range'));
  assert.ok(!merchants.includes('Out Of Range'), 'date filter must exclude out-of-range row');
});

// ---------------- GET /enrichment/stats ----------------

test('GET /enrichment/stats: superadmin gets 200 with correct shape, non-superadmin gets household-scoped totals', async () => {
  // Seed unique merchants in each household so total counts diverge.
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2027-01-01',
    amount: -1,
    merchantRaw: 'StatsA-Merchant',
    merchantCanonical: 'STATS_A_MERCHANT',
  });
  await createTxn({
    householdId: householdBId,
    accountId: accountBId,
    date: '2027-01-01',
    amount: -1,
    merchantRaw: 'StatsB-Merchant',
    merchantCanonical: 'STATS_B_MERCHANT',
  });

  const aRes = await agentA.get('/api/transactions/enrichment/stats');
  assert.equal(aRes.status, 200);
  for (const key of [
    'total',
    'reviewFlagTrue',
    'reviewFlagFalse',
    'reviewedTrue',
    'bySource',
    'byConfidence',
    'byTxnType',
    'isRecurringCount',
    'refundLinkedCount',
    'transferLinkedCount',
    'topCanonicalMerchants',
    'topRules',
  ]) {
    assert.ok(key in aRes.body, `missing key in response: ${key}`);
  }
  const aMerchants = (aRes.body.topCanonicalMerchants as Array<{ name: string }>).map((m) => m.name);
  assert.ok(aMerchants.includes('STATS_A_MERCHANT'));
  assert.ok(
    !aMerchants.includes('STATS_B_MERCHANT'),
    'household A must not see household B canonical merchant',
  );

  const superRes = await superAgent.get('/api/transactions/enrichment/stats');
  assert.equal(superRes.status, 200);
  // Superadmin's total must be >= A's total (sees everything).
  assert.ok(
    Number(superRes.body.total) >= Number(aRes.body.total),
    `superadmin total (${superRes.body.total}) must be >= A's total (${aRes.body.total})`,
  );
  const superMerchants = (superRes.body.topCanonicalMerchants as Array<{ name: string }>).map(
    (m) => m.name,
  );
  // Superadmin sees both households' merchants (assuming top-15 cap not exceeded by other test rows).
  assert.ok(superMerchants.includes('STATS_A_MERCHANT'));
  assert.ok(superMerchants.includes('STATS_B_MERCHANT'));
});

// ---------------- Issue #215: refund-link manual endpoints ----------------

test('POST /:id/refund-link: links a refund to its original purchase', async () => {
  const originalId = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-05-01',
    amount: -100,
    merchantClean: 'BEST BUY',
    finalCategory: 'Electronics',
    txnType: 'purchase',
    createdByUserId: userAId,
  });
  const refundId = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-05-10',
    amount: 100,
    merchantClean: 'BEST BUY',
    txnType: 'refund',
    createdByUserId: userAId,
  });
  const res = await agentA
    .post(`/api/transactions/${refundId}/refund-link`)
    .send({ originalTransactionId: originalId });
  assert.equal(res.status, 200);
  assert.equal(res.body.linkedTransactionId, originalId);
  assert.equal(res.body.txnType, 'refund');
  assert.equal(res.body.autoSource, 'refund-link');
  assert.equal(res.body.autoConfidence, 'high');
  assert.equal(res.body.reviewFlag, false);
  void contactAId;
  void contactBId;
});

test('POST /:id/refund-link: rejects when currencies differ', async () => {
  const originalId = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-05-01',
    amount: -100,
    currency: 'USD',
    merchantClean: 'BEST BUY USD',
    txnType: 'purchase',
    createdByUserId: userAId,
  });
  const refundId = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-05-10',
    amount: 100,
    currency: 'CAD',
    merchantClean: 'BEST BUY CAD',
    txnType: 'refund',
    createdByUserId: userAId,
  });
  const res = await agentA
    .post(`/api/transactions/${refundId}/refund-link`)
    .send({ originalTransactionId: originalId });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /currencies must match/i);
});

test('POST /:id/refund-link: rejects when refund row is itself negative', async () => {
  const originalId = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-05-01',
    amount: -100,
    merchantClean: 'NEGATIVE-REFUND-CASE',
    txnType: 'purchase',
    createdByUserId: userAId,
  });
  // Pretend a misclassified "refund" with a negative amount.
  const refundId = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-05-10',
    amount: -50,
    merchantClean: 'NEGATIVE-REFUND-CASE',
    txnType: 'refund',
    createdByUserId: userAId,
  });
  const res = await agentA
    .post(`/api/transactions/${refundId}/refund-link`)
    .send({ originalTransactionId: originalId });
  assert.equal(res.status, 400);
});

test('POST /:id/refund-link: cross-household original returns 404', async () => {
  const originalIdB = await createTxn({
    householdId: householdBId,
    accountId: accountBId,
    date: '2026-05-01',
    amount: -100,
    merchantClean: 'FOREIGN PURCHASE',
    txnType: 'purchase',
    createdByUserId: userBId,
  });
  const refundIdA = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-05-10',
    amount: 100,
    merchantClean: 'LOCAL REFUND',
    txnType: 'refund',
    createdByUserId: userAId,
  });
  const res = await agentA
    .post(`/api/transactions/${refundIdA}/refund-link`)
    .send({ originalTransactionId: originalIdB });
  assert.equal(res.status, 404);
});

test('DELETE /:id/refund-link: clears linkedTransactionId', async () => {
  const originalId = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-05-01',
    amount: -100,
    merchantClean: 'UNLINK TEST',
    txnType: 'purchase',
    createdByUserId: userAId,
  });
  const refundId = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-05-10',
    amount: 100,
    merchantClean: 'UNLINK TEST',
    txnType: 'refund',
    createdByUserId: userAId,
  });
  // Link, then unlink.
  await agentA
    .post(`/api/transactions/${refundId}/refund-link`)
    .send({ originalTransactionId: originalId });
  const res = await agentA.delete(`/api/transactions/${refundId}/refund-link`);
  assert.equal(res.status, 200);
  assert.equal(res.body.linkedTransactionId, null);
});

test('GET /:id/refund-details: returns hydrated original + partial flag for partial refund', async () => {
  const originalId = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-05-01',
    amount: -200,
    merchantClean: 'PARTIAL CASE',
    finalCategory: 'Electronics',
    txnType: 'purchase',
    createdByUserId: userAId,
  });
  const refundId = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-05-10',
    amount: 50,
    merchantClean: 'PARTIAL CASE',
    txnType: 'refund',
    createdByUserId: userAId,
  });
  await agentA
    .post(`/api/transactions/${refundId}/refund-link`)
    .send({ originalTransactionId: originalId });

  const res = await agentA.get(`/api/transactions/${refundId}/refund-details`);
  assert.equal(res.status, 200);
  assert.equal(res.body.linked, true);
  assert.equal(res.body.partial, true);
  assert.equal(res.body.original.id, originalId);
  assert.equal(res.body.original.finalCategory, 'Electronics');
  assert.equal(res.body.original.amount, -200);
});

test('GET /:id/refund-details: linked=false when no link exists', async () => {
  const refundId = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-05-10',
    amount: 25,
    merchantClean: 'NO LINK YET',
    txnType: 'refund',
    createdByUserId: userAId,
  });
  const res = await agentA.get(`/api/transactions/${refundId}/refund-details`);
  assert.equal(res.status, 200);
  assert.equal(res.body.linked, false);
  assert.equal(res.body.original, null);
});

test('GET /refund-suggestions: surfaces unreviewed auto-linked refunds', async () => {
  const originalId = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-05-01',
    amount: -75,
    merchantClean: 'SUGGEST QUEUE',
    finalCategory: 'Shopping',
    txnType: 'purchase',
    createdByUserId: userAId,
  });
  const refundId = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-05-10',
    amount: 75,
    merchantClean: 'SUGGEST QUEUE',
    txnType: 'refund',
    createdByUserId: userAId,
  });
  // Manually mark this refund as auto-linked + unreviewed so it shows in queue.
  const models = await import('../../src/models');
  await models.Transaction.update(
    {
      linkedTransactionId: originalId,
      autoSource: 'refund-link',
      autoConfidence: 'high',
      reviewedAt: null,
    },
    { where: { id: refundId } }
  );

  const res = await agentA.get('/api/transactions/refund-suggestions');
  assert.equal(res.status, 200);
  const rows = res.body.data as Array<{ refundId: number; linkedOriginal: { id: number } | null }>;
  const ours = rows.find((r) => r.refundId === refundId);
  assert.ok(ours, 'refund should appear in the suggestions queue');
  assert.equal(ours!.linkedOriginal?.id, originalId);
});
