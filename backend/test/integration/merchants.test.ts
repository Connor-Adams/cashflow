/**
 * Integration tests for `backend/src/routes/merchants.ts`:
 *   - GET /api/merchants
 *   - GET /api/merchants/:name
 *   - GET /api/merchants/:name/transactions
 *
 * Setup mirrors `summary.test.ts`: one Postgres test DB, bootstrap
 * superadmin, plus two non-superadmin households (A and B) seeded via
 * `seedHousehold`. Each household gets its own session-cookie supertest
 * agent so we can assert household scoping.
 *
 * Transactions are inserted via `Transaction.create` with all NOT NULL
 * fields explicit, so the route's `visibleTransactionWhere` filter has
 * a real (`visibility:'shared'`) row to match. Tests deliberately seed
 * one of each shape we care about:
 *   - exact merchant strings to exercise the COALESCE matching
 *   - canonical + clean variants of the same brand to test grouping
 *   - rows in CAD and USD to test currency filtering
 *   - a recurring row to verify the `isRecurring` flag
 *   - a row with a receipt to verify receiptCoverage
 *   - a row in household B to verify cross-household isolation
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
let accountAId: number;
let accountAUsdId: number;
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
  txnType?: string;
  isRecurring?: boolean;
  visibility?: string;
  createdByUserId?: number | null;
};

async function createTxn(seed: TxnSeed): Promise<number> {
  const models = await import('../../src/models');
  const row = await models.Transaction.create({
    accountId: seed.accountId,
    householdId: seed.householdId,
    visibility: seed.visibility ?? 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'merchants-test',
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
    myShareAmount: String(seed.amount).toString(),
    partnerShareAmount: '0',
    businessAmount: '0',
    txnType: seed.txnType ?? 'purchase',
    autoSource: null,
    autoConfidence: null,
    linkedTransactionId: null,
    isRecurring: seed.isRecurring ?? false,
    reviewFlag: false,
    reviewedAt: null,
    createdByUserId: seed.createdByUserId ?? null,
  });
  return row.id;
}

before(async () => {
  process.env.NODE_ENV = 'test';

  testDb = await setupPgTestDb('merchants');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const superAgent = request.agent(app);
  const register = await superAgent.post('/api/auth/register').send({
    email: 'super-merchants@example.com',
    displayName: 'Super Merchants',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const a = await seedHousehold('MerchantsA', 'A Partner');
  householdAId = a.householdId;
  userAId = a.userId;
  agentA = request.agent(app);
  agentA.jar.setCookie(`cashflow_session=${a.token}; Path=/`);

  const b = await seedHousehold('MerchantsB', 'B Partner');
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
  const acctAUsd = await models.Account.create({
    householdId: householdAId,
    ownerUserId: userAId,
    owner: 'me',
    visibility: 'shared',
    name: 'A USD Card',
    accountType: 'credit_card',
    defaultCurrency: 'USD',
    shortCode: 'A-USD',
  });
  accountAUsdId = acctAUsd.id;
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

// ---------------- GET /api/merchants ----------------

test('/merchants: top merchants sorted by net spend desc, grouped by (currency, key)', async () => {
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-01-01',
    amount: -30,
    merchantRaw: 'Cafe Top',
    merchantClean: 'Cafe Top',
  });
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-01-02',
    amount: -10,
    merchantRaw: 'Cafe Top',
    merchantClean: 'Cafe Top',
  });
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-01-03',
    amount: -5,
    merchantRaw: 'Cafe Lite',
    merchantClean: 'Cafe Lite',
  });

  const res = await agentA.get('/api/merchants');
  assert.equal(res.status, 200);
  const top = res.body.data as Array<{ merchant: string; netSpend: number; currency: string }>;
  const cafeTop = top.find((m) => m.merchant === 'Cafe Top');
  const cafeLite = top.find((m) => m.merchant === 'Cafe Lite');
  assert.ok(cafeTop, 'Cafe Top must appear');
  assert.ok(cafeLite, 'Cafe Lite must appear');
  assert.equal(cafeTop.netSpend, 40);
  assert.equal(cafeLite.netSpend, 5);
  // Cafe Top precedes Cafe Lite in the sorted list.
  assert.ok(
    top.indexOf(cafeTop) < top.indexOf(cafeLite),
    `expected Cafe Top before Cafe Lite, got ${JSON.stringify(top.map((m) => m.merchant))}`,
  );
});

test('/merchants?search=cafe substring-filters case-insensitively across raw/clean/canonical', async () => {
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-04-01',
    amount: -15,
    merchantRaw: 'sq *MOMS DINER',
    merchantClean: 'MOMS DINER',
    merchantCanonical: 'Mom\'s Diner',
  });

  const res = await agentA.get('/api/merchants').query({ search: 'cafe' });
  assert.equal(res.status, 200);
  for (const m of res.body.data as Array<{ merchant: string }>) {
    assert.ok(
      /cafe/i.test(m.merchant),
      `search=cafe leaked non-cafe merchant ${m.merchant}`,
    );
  }

  const res2 = await agentA.get('/api/merchants').query({ search: 'diner' });
  assert.equal(res2.status, 200);
  const moms = (res2.body.data as Array<{ merchant: string }>).find((m) =>
    /diner/i.test(m.merchant),
  );
  assert.ok(moms, 'search=diner must match MOMS DINER row');
});

test('/merchants household scoping: agentB does not see household A merchants', async () => {
  // householdB has no transactions yet, but household A has many.
  const resB = await agentB.get('/api/merchants');
  assert.equal(resB.status, 200);
  assert.equal(
    (resB.body.data as Array<unknown>).length,
    0,
    'household B should see zero merchants until it has its own data',
  );

  await createTxn({
    householdId: householdBId,
    accountId: accountBId,
    date: '2026-05-01',
    amount: -7,
    merchantRaw: 'B-Only Merchant',
    merchantClean: 'B-Only Merchant',
  });

  const resB2 = await agentB.get('/api/merchants');
  const merchants = (resB2.body.data as Array<{ merchant: string }>).map((m) => m.merchant);
  assert.deepEqual(merchants, ['B-Only Merchant']);

  // agentA must not see household B merchant.
  const resA = await agentA.get('/api/merchants');
  const aMerchants = (resA.body.data as Array<{ merchant: string }>).map((m) => m.merchant);
  assert.ok(
    !aMerchants.includes('B-Only Merchant'),
    `cross-household leak: ${JSON.stringify(aMerchants)}`,
  );
});

// ---------------- GET /api/merchants/:name ----------------

test('/merchants/:name returns totals, monthlyTrend, byCategory, isRecurring, availableCurrencies', async () => {
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-06-01',
    amount: -100,
    finalCategory: 'Groceries',
    merchantRaw: 'Costco #1',
    merchantClean: 'Costco',
    merchantCanonical: 'Costco',
  });
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-07-15',
    amount: -50,
    finalCategory: 'Groceries',
    merchantRaw: 'Costco #2',
    merchantClean: 'Costco',
    merchantCanonical: 'Costco',
    isRecurring: true,
  });
  await createTxn({
    householdId: householdAId,
    accountId: accountAUsdId,
    date: '2026-07-20',
    amount: -25,
    currency: 'USD',
    finalCategory: 'Groceries',
    merchantRaw: 'Costco US',
    merchantClean: 'Costco',
    merchantCanonical: 'Costco',
  });

  const res = await agentA.get('/api/merchants/Costco').query({ currency: 'CAD' });
  assert.equal(res.status, 200);
  assert.equal(res.body.merchant, 'Costco');
  assert.equal(res.body.currency, 'CAD');
  assert.equal(res.body.totals.totalSpend, 150);
  assert.equal(res.body.totals.netSpend, 150);
  assert.equal(res.body.totals.transactionCount, 2);
  assert.equal(res.body.totals.firstDate, '2026-06-01');
  assert.equal(res.body.totals.lastDate, '2026-07-15');
  assert.equal(res.body.isRecurring, true, 'one row had isRecurring=true');

  const months = (res.body.monthlyTrend as Array<{ month: string }>).map((m) => m.month);
  assert.deepEqual(months, ['2026-06', '2026-07']);

  const groceries = (res.body.byCategory as Array<{ category: string | null; totalSpend: number }>)
    .find((b) => b.category === 'Groceries');
  assert.ok(groceries);
  assert.equal(groceries.totalSpend, 150);

  const currencies = res.body.availableCurrencies as string[];
  assert.deepEqual(currencies.sort(), ['CAD', 'USD']);
});

test('/merchants/:name without currency aggregates across currencies', async () => {
  const res = await agentA.get('/api/merchants/Costco');
  assert.equal(res.status, 200);
  // 100 + 50 + 25 = 175 across CAD + USD (aggregator does not slice by currency)
  assert.equal(res.body.totals.totalSpend, 175);
  assert.equal(res.body.totals.transactionCount, 3);
});

test('/merchants/:name groups merchantCanonical and merchantClean variants together', async () => {
  // Existing Costco rows have canonical='Costco'. Add an unmapped row whose
  // clean column already says 'Costco' so the route's OR-match catches it.
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-08-01',
    amount: -20,
    merchantRaw: 'COSTCO WHOLESALE 1234',
    merchantClean: 'Costco',
    merchantCanonical: null,
  });

  const res = await agentA.get('/api/merchants/Costco').query({ currency: 'CAD' });
  // 100 + 50 + 20 = 170 in CAD now
  assert.equal(res.body.totals.totalSpend, 170);
  assert.equal(res.body.totals.transactionCount, 3);
});

test('/merchants/:name includes relatedRules matching substring of merchantPattern', async () => {
  const models = await import('../../src/models');
  await models.Rule.create({
    householdId: householdAId,
    matchKind: 'substring',
    priority: 1,
    merchantPattern: 'Costco',
    category: 'Groceries',
    isBusiness: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
    effectiveFrom: null,
    effectiveTo: null,
  });
  await models.Rule.create({
    householdId: householdAId,
    matchKind: 'substring',
    priority: 2,
    merchantPattern: 'Cafe',
    category: 'Dining',
    isBusiness: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
    effectiveFrom: null,
    effectiveTo: null,
  });

  const res = await agentA.get('/api/merchants/Costco');
  assert.equal(res.status, 200);
  const rules = res.body.relatedRules as Array<{ merchantPattern: string }>;
  const patterns = rules.map((r) => r.merchantPattern);
  assert.ok(patterns.includes('Costco'), `expected Costco rule, got ${JSON.stringify(patterns)}`);
  assert.ok(!patterns.includes('Cafe'), 'Cafe rule must not match Costco merchant');
});

test('/merchants/:name returns 400 for empty name (would be unreachable but handled defensively)', async () => {
  // The route definition /:name guards against an empty path segment via the
  // `if (!name)` check after `String(req.params.name).trim()`. The /:name
  // route won't even match on empty paths, but we still validate the trimmed
  // input.
  const res = await agentA.get('/api/merchants/%20');
  assert.equal(res.status, 400);
});

test('/merchants/:name household scoping: agentB cannot see household A merchant', async () => {
  const res = await agentB.get('/api/merchants/Costco');
  assert.equal(res.status, 200);
  assert.equal(res.body.totals.transactionCount, 0, 'B sees zero rows for A-only merchant');
  assert.deepEqual(res.body.availableCurrencies, [], 'B sees no currencies for A-only merchant');
});

// ---------------- GET /api/merchants/:name/transactions ----------------

test('/merchants/:name/transactions returns paginated rows scoped to merchant', async () => {
  const res = await agentA
    .get('/api/merchants/Costco/transactions')
    .query({ currency: 'CAD', pageSize: 2, page: 1 });
  assert.equal(res.status, 200);
  assert.equal(res.body.pageSize, 2);
  assert.equal(res.body.page, 1);
  assert.ok(res.body.total >= 3, `expected >=3 CAD Costco rows, got ${res.body.total}`);
  assert.equal((res.body.data as Array<unknown>).length, 2);

  const res2 = await agentA
    .get('/api/merchants/Costco/transactions')
    .query({ currency: 'CAD', pageSize: 2, page: 2 });
  assert.equal(res2.status, 200);
  assert.ok((res2.body.data as Array<unknown>).length >= 1);

  // Date-descending order
  const dates = (res.body.data as Array<{ date: string }>).map((r) => r.date);
  for (let i = 1; i < dates.length; i++) {
    assert.ok(
      dates[i - 1] >= dates[i],
      `transactions must be date-desc, got ${JSON.stringify(dates)}`,
    );
  }
});

test('/merchants/:name/transactions household scoping: agentB cannot read household A txns', async () => {
  const res = await agentB.get('/api/merchants/Costco/transactions');
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 0);
  assert.deepEqual(res.body.data, []);
});

// ---------------- receipt coverage ----------------

test('/merchants/:name receiptCoverage counts attached receipts', async () => {
  const models = await import('../../src/models');
  const txnId = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-09-01',
    amount: -50,
    merchantRaw: 'ReceiptCo',
    merchantClean: 'ReceiptCo',
  });
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-09-02',
    amount: -25,
    merchantRaw: 'ReceiptCo',
    merchantClean: 'ReceiptCo',
  });
  await models.Receipt.create({
    transactionId: txnId,
    storedFilename: 'r.pdf',
    originalName: 'r.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    extractedNote: null,
    externalOrderId: null,
  });

  const res = await agentA.get('/api/merchants/ReceiptCo');
  assert.equal(res.status, 200);
  assert.equal(res.body.receiptCoverage.totalCount, 2);
  assert.equal(res.body.receiptCoverage.withReceiptCount, 1);
  assert.equal(res.body.receiptCoverage.missingCount, 1);
  assert.equal(res.body.receiptCoverage.coverageByCount, 0.5);
});
