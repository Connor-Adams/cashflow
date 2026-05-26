/**
 * Integration tests for the Sankey routes (issue #224).
 *
 * Exercises:
 *   - GET /api/summary/sankey
 *       - currency filter shapes the response (one currency per call)
 *       - dateFrom/dateTo restrict the rollup
 *       - flow totals reconcile with the underlying transactions
 *       - internal transfers (txnType=transfer/investment/dividend)
 *         contribute zero — no double counting (AC bullet)
 *       - empty / insufficient data → empty nodes + zero totals (AC)
 *       - missing currency returns the available list so the page can
 *         render the picker before its first aggregation
 *       - household scoping: another household's txns never leak in
 *   - GET /api/summary/sankey/source-transactions
 *       - returns the row IDs that flowed through a clicked edge (AC)
 *       - validates source/target are non-negative integers
 *       - unknown edge returns zero rows (not a 404 — the chart's link
 *         indices may stale across re-fetches)
 *       - household scoping enforced via belt-and-suspenders id filter
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import {
  setupPgTestDb,
  teardownPgTestDb,
  type PgTestDb,
} from './_setup/pgTestDb.js';

let app: import('express').Express;
let primaryAgent: ReturnType<typeof request.agent>;
let primaryHouseholdId: number;
let primaryUserId: number;
let primaryAccountId: number;
let primaryInvestmentAccountId: number;
let otherAgent: ReturnType<typeof request.agent>;
let otherHouseholdId: number;
let otherUserId: number;
let otherAccountId: number;
let testDb: PgTestDb;

type Seeded = {
  token: string;
  householdId: number;
  userId: number;
  accountId: number;
  investmentAccountId: number;
};

async function seed(emailPrefix: string): Promise<Seeded> {
  const models = await import('../../src/models');
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `${emailPrefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    displayName: emailPrefix,
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({
    name: `${emailPrefix} household`,
  });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  // shortCode is unique per (householdId, shortCode); the secondary account
  // appends a 'B' suffix so the two seeded accounts coexist.
  const cardCode = `${emailPrefix.slice(0, 2).toUpperCase()}A`;
  const investCode = `${emailPrefix.slice(0, 2).toUpperCase()}B`;
  const account = await models.Account.create({
    householdId: household.id,
    ownerUserId: user.id,
    owner: 'me',
    visibility: 'shared',
    name: `${emailPrefix} card`,
    accountType: 'credit',
    defaultCurrency: 'CAD',
    shortCode: cardCode,
  });
  const investmentAccount = await models.Account.create({
    householdId: household.id,
    ownerUserId: user.id,
    owner: 'me',
    visibility: 'shared',
    name: `${emailPrefix} brokerage`,
    accountType: 'investment',
    defaultCurrency: 'CAD',
    shortCode: investCode,
  });
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });
  return {
    token,
    householdId: household.id,
    userId: user.id,
    accountId: account.id,
    investmentAccountId: investmentAccount.id,
  };
}

interface TxnOptions {
  currency?: string;
  finalCategory?: string | null;
  finalBusiness?: boolean;
  txnType?: string;
  merchant?: string;
  accountId?: number;
}

async function createTxn(
  householdId: number,
  defaultAccountId: number,
  userId: number,
  date: string,
  amount: number,
  options: TxnOptions = {},
): Promise<number> {
  const models = await import('../../src/models');
  const row = await models.Transaction.create({
    accountId: options.accountId ?? defaultAccountId,
    householdId,
    // visibility=shared lets the seeded user see the row via
    // visibleTransactionWhere (which checks visibility OR
    // createdByUserId). Some tests seed createdByUserId instead — both
    // satisfy the constraint.
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'sankey-test',
    date,
    merchantRaw: options.merchant ?? 'Test',
    merchantClean: options.merchant ?? 'Test',
    merchantCanonical: null,
    amount: amount.toFixed(4),
    currency: options.currency ?? 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: options.finalCategory ?? null,
    autoBusiness: null,
    businessOverride: options.finalBusiness ?? null,
    finalBusiness: options.finalBusiness ?? false,
    autoSplitType: null,
    splitOverride: null,
    finalSplitType: 'me',
    autoPctMe: null,
    pctMeOverride: null,
    finalPctMe: null,
    autoPctPartner: null,
    pctPartnerOverride: null,
    finalPctPartner: null,
    txnType: options.txnType ?? (amount < 0 ? 'purchase' : 'income'),
    reviewFlag: false,
    reviewedAt: null,
    createdByUserId: userId,
  });
  return row.id;
}

before(async () => {
  testDb = await setupPgTestDb('sankey');
  const mod = await import('../../src/app.js');
  app = mod.default;

  // Superadmin must exist before any seed() call — the registration
  // endpoint promotes the first user to superadmin globally.
  const bootstrap = request.agent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const primary = await seed('Primary');
  primaryHouseholdId = primary.householdId;
  primaryUserId = primary.userId;
  primaryAccountId = primary.accountId;
  primaryInvestmentAccountId = primary.investmentAccountId;
  primaryAgent = request.agent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('Other');
  otherHouseholdId = other.householdId;
  otherUserId = other.userId;
  otherAccountId = other.accountId;
  otherAgent = request.agent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// ---- GET /api/summary/sankey -------------------------------------------

test('GET /api/summary/sankey: missing currency returns available list + zero totals', async () => {
  // No data seeded yet → availableCurrencies empty + zero totals.
  const res = await primaryAgent.get('/api/summary/sankey');
  assert.equal(res.status, 200);
  assert.equal(res.body.currency, null);
  assert.equal(res.body.totalIncome, 0);
  assert.equal(res.body.totalSpend, 0);
  assert.deepEqual(res.body.nodes, []);
  assert.deepEqual(res.body.links, []);
  assert.deepEqual(res.body.availableCurrencies, []);
});

test('GET /api/summary/sankey: empty data with currency → zero totals (AC: empty state clear)', async () => {
  const res = await primaryAgent.get('/api/summary/sankey').query({ currency: 'CAD' });
  assert.equal(res.status, 200);
  assert.equal(res.body.currency, 'CAD');
  assert.equal(res.body.totalIncome, 0);
  assert.equal(res.body.totalSpend, 0);
  assert.deepEqual(res.body.nodes, []);
  assert.deepEqual(res.body.links, []);
});

test('GET /api/summary/sankey: rolls up by category for a single currency (AC: view flows for period)', async () => {
  // Seed a small ledger: income + categorized spend + business spend.
  await createTxn(primaryHouseholdId, primaryAccountId, primaryUserId, '2026-03-01', 5000, {
    txnType: 'income',
    merchant: 'EMPLOYER',
  });
  await createTxn(primaryHouseholdId, primaryAccountId, primaryUserId, '2026-03-05', -150, {
    finalCategory: 'Groceries',
  });
  await createTxn(primaryHouseholdId, primaryAccountId, primaryUserId, '2026-03-10', -75, {
    finalCategory: 'Groceries',
  });
  await createTxn(primaryHouseholdId, primaryAccountId, primaryUserId, '2026-03-12', -200, {
    finalCategory: 'Software',
    finalBusiness: true,
  });

  const res = await primaryAgent
    .get('/api/summary/sankey')
    .query({ currency: 'CAD' });
  assert.equal(res.status, 200);
  assert.equal(res.body.currency, 'CAD');
  assert.equal(res.body.totalIncome, 5000);
  assert.equal(res.body.totalSpend, 225 + 200);
  // Income source + at least Groceries + Business spending sinks.
  const names: string[] = res.body.nodes.map((n: { name: string }) => n.name);
  assert.ok(names.includes('Income'));
  assert.ok(names.includes('Groceries'));
  assert.ok(names.includes('Business spending'));
  // CAD should now appear in availableCurrencies.
  assert.ok(res.body.availableCurrencies.includes('CAD'));
});

test('GET /api/summary/sankey: filters by currency (AC: currency filter)', async () => {
  // Seed a USD purchase so the available list has both CAD + USD.
  await createTxn(primaryHouseholdId, primaryAccountId, primaryUserId, '2026-03-15', -40, {
    finalCategory: 'Travel',
    currency: 'USD',
  });

  const usd = await primaryAgent.get('/api/summary/sankey').query({ currency: 'USD' });
  assert.equal(usd.status, 200);
  assert.equal(usd.body.currency, 'USD');
  // Only the 40 USD travel row contributes — totals reflect a single currency.
  assert.equal(usd.body.totalSpend, 40);
  const usdNames: string[] = usd.body.nodes.map((n: { name: string }) => n.name);
  assert.ok(usdNames.includes('Travel'));
  // Groceries (CAD) must NOT leak into the USD response.
  assert.ok(!usdNames.includes('Groceries'));

  // available list should now carry both CAD + USD.
  assert.deepEqual(usd.body.availableCurrencies.sort(), ['CAD', 'USD']);
});

test('GET /api/summary/sankey: dateFrom/dateTo restrict the window (AC: date filter)', async () => {
  // Window the original CAD ledger to just March 5 — should leave just
  // one Groceries row.
  const res = await primaryAgent.get('/api/summary/sankey').query({
    currency: 'CAD',
    dateFrom: '2026-03-05',
    dateTo: '2026-03-05',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.totalIncome, 0);
  assert.equal(res.body.totalSpend, 150);
  // Only Groceries — no Business, no Income (date excludes both).
  const names: string[] = res.body.nodes.map((n: { name: string }) => n.name);
  assert.ok(names.includes('Groceries'));
  assert.ok(!names.includes('Business spending'));
});

test('GET /api/summary/sankey: rejects invalid currency code', async () => {
  // 4 letters → invalid. Endpoint treats it as "no currency", returning
  // the available list rather than an error (the page can show the
  // empty state + prompt the user to pick).
  const res = await primaryAgent
    .get('/api/summary/sankey')
    .query({ currency: 'INVALID' });
  assert.equal(res.status, 200);
  assert.equal(res.body.currency, null);
});

test('GET /api/summary/sankey: internal transfers do not contribute (AC: no double counting)', async () => {
  // Two transfer rows that cancel out, plus an investment buy. They must
  // not register as either income or spend. Seed a fresh currency so
  // we can assert the response in isolation.
  await createTxn(primaryHouseholdId, primaryAccountId, primaryUserId, '2026-04-01', -1000, {
    currency: 'EUR',
    txnType: 'transfer',
    merchant: 'TRANSFER OUT',
  });
  await createTxn(primaryHouseholdId, primaryAccountId, primaryUserId, '2026-04-01', 1000, {
    currency: 'EUR',
    txnType: 'transfer',
    merchant: 'TRANSFER IN',
  });
  await createTxn(
    primaryHouseholdId,
    primaryInvestmentAccountId,
    primaryUserId,
    '2026-04-02',
    -500,
    { currency: 'EUR', txnType: 'investment', merchant: 'VTI BUY' },
  );

  const res = await primaryAgent.get('/api/summary/sankey').query({ currency: 'EUR' });
  assert.equal(res.status, 200);
  assert.equal(res.body.currency, 'EUR');
  // Zero — all three rows excluded.
  assert.equal(res.body.totalIncome, 0);
  assert.equal(res.body.totalSpend, 0);
  // Nodes empty since no spend or income flowed.
  assert.deepEqual(res.body.nodes, []);
  assert.deepEqual(res.body.links, []);
});

test('GET /api/summary/sankey: refund nets the category it offset', async () => {
  // Spend 100, refund 30 for the same category — netSpend should land at 70.
  await createTxn(primaryHouseholdId, primaryAccountId, primaryUserId, '2026-05-01', -100, {
    currency: 'GBP',
    finalCategory: 'Returns',
  });
  await createTxn(primaryHouseholdId, primaryAccountId, primaryUserId, '2026-05-02', 30, {
    currency: 'GBP',
    finalCategory: 'Returns',
    txnType: 'refund',
    merchant: 'STORE REFUND',
  });

  const res = await primaryAgent.get('/api/summary/sankey').query({ currency: 'GBP' });
  assert.equal(res.status, 200);
  assert.equal(res.body.totalSpend, 70);
  // Single sink: Returns.
  const sinkLinks: Array<{ source: number; target: number; value: number }> = res.body.links;
  assert.equal(sinkLinks.length, 1);
  assert.equal(sinkLinks[0].value, 70);
});

test('GET /api/summary/sankey: scoped to household (other household gets empty result)', async () => {
  // Primary has many CAD txns by now; Other has none and should see zero.
  const res = await otherAgent.get('/api/summary/sankey').query({ currency: 'CAD' });
  assert.equal(res.status, 200);
  assert.equal(res.body.totalIncome, 0);
  assert.equal(res.body.totalSpend, 0);
  assert.equal(res.body.availableCurrencies.length, 0);
});

// ---- GET /api/summary/sankey/source-transactions ----------------------

test('GET /api/summary/sankey/source-transactions: drills into a clicked edge (AC: click for source txns)', async () => {
  // Fetch the Sankey for primary CAD; pick the Groceries link and verify
  // the drill-down returns the two seeded Groceries rows.
  const sankey = await primaryAgent
    .get('/api/summary/sankey')
    .query({ currency: 'CAD' });
  assert.equal(sankey.status, 200);
  const groceriesIdx = sankey.body.nodes.findIndex(
    (n: { name: string }) => n.name === 'Groceries',
  );
  assert.ok(groceriesIdx >= 1, 'Groceries node should be present');

  const drill = await primaryAgent.get('/api/summary/sankey/source-transactions').query({
    currency: 'CAD',
    source: 0,
    target: groceriesIdx,
  });
  assert.equal(drill.status, 200);
  assert.equal(drill.body.edge.source, 0);
  assert.equal(drill.body.edge.target, groceriesIdx);
  assert.equal(drill.body.transactionCount, 2);
  assert.equal(drill.body.transactions.length, 2);
  for (const t of drill.body.transactions as Array<{
    finalCategory: string;
    currency: string;
    amount: number;
  }>) {
    assert.equal(t.finalCategory, 'Groceries');
    assert.equal(t.currency, 'CAD');
    // Stored as negative; the drill returns the signed amount.
    assert.ok(t.amount < 0);
  }
});

test('GET /api/summary/sankey/source-transactions: validates source/target', async () => {
  const badSource = await primaryAgent
    .get('/api/summary/sankey/source-transactions')
    .query({ currency: 'CAD', source: 'abc', target: 1 });
  assert.equal(badSource.status, 400);
  const badTarget = await primaryAgent
    .get('/api/summary/sankey/source-transactions')
    .query({ currency: 'CAD', source: 0, target: -1 });
  assert.equal(badTarget.status, 400);
  const missingCurrency = await primaryAgent
    .get('/api/summary/sankey/source-transactions')
    .query({ source: 0, target: 1 });
  assert.equal(missingCurrency.status, 400);
});

test('GET /api/summary/sankey/source-transactions: unknown edge returns zero rows (not 404)', async () => {
  // Sankey indices can stale across re-fetches; an unknown edge is a
  // recoverable empty state, not a hard error.
  const res = await primaryAgent
    .get('/api/summary/sankey/source-transactions')
    .query({ currency: 'CAD', source: 99, target: 100 });
  assert.equal(res.status, 200);
  assert.equal(res.body.transactionCount, 0);
  assert.deepEqual(res.body.transactions, []);
});

test('GET /api/summary/sankey/source-transactions: scoped to household', async () => {
  // Other household has no CAD data — drilling into a hypothetical
  // edge must return zero rows even if primary household has txns.
  const res = await otherAgent
    .get('/api/summary/sankey/source-transactions')
    .query({ currency: 'CAD', source: 0, target: 1 });
  assert.equal(res.status, 200);
  assert.equal(res.body.transactionCount, 0);
});
