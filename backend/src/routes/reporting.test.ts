/**
 * DB-backed unit tests for the /api/v1 reporting routes' money math.
 *
 * Mounts the reporting router behind a stubbed reportingAuth (the routes only
 * read `req.reportingAuth.household`) on the per-process SQLite test DB, so
 * the assertions exercise the real Sequelize queries:
 *
 *  - /tax grossIncome uses the same income peel as /summary (only
 *    txnType='income'), not every positive non-payment/transfer row
 *  - /summary netWorth and /projections investmentValue derive investment
 *    accounts from holdings market value, not the txn-stream residual
 *  - /cashflow/monthly and /spending/by-category pass the row's accountType
 *    to isNonSpend so unrecognized brokerage debits don't count as expenses
 */
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';

process.env.DATABASE_PATH = ':memory:';

let models: typeof import('../models');
let app: express.Express;
let household: { id: number };

before(async () => {
  models = await import('../models');
  await models.sequelize.sync({ force: true });
  const reportingRouter = (await import('./reporting')).default;
  app = express();
  app.use((req, _res, next) => {
    req.reportingAuth = { household } as unknown as NonNullable<typeof req.reportingAuth>;
    next();
  });
  app.use(reportingRouter);
});

after(async () => {
  await models.sequelize.close();
});

beforeEach(async () => {
  await models.TransactionOrderLink.destroy({ where: {}, truncate: true });
  await models.ExternalOrderItem.destroy({ where: {}, truncate: true });
  await models.ExternalOrder.destroy({ where: {}, truncate: true });
  await models.Transaction.destroy({ where: {}, truncate: true });
  await models.HoldingSnapshot.destroy({ where: {}, truncate: true });
  await models.SecurityPrice.destroy({ where: {}, truncate: true });
  await models.Security.destroy({ where: {}, truncate: true });
  await models.TaxReserveSetting.destroy({ where: {}, truncate: true });
  await models.Account.destroy({ where: {}, truncate: true });
  await models.Household.destroy({ where: {}, truncate: true });
  household = await models.Household.create({ name: 'Reporting Test HH' });
});

async function seedAccount(name: string, accountType: string): Promise<number> {
  const acc = await models.Account.create({
    householdId: household.id,
    ownerUserId: null,
    owner: 'me',
    visibility: 'shared',
    name,
    accountType,
    defaultCurrency: 'CAD',
    shortCode: name.slice(0, 3).toUpperCase(),
  });
  return acc.id;
}

async function seedTxnReturningId(
  accountId: number,
  date: string,
  amount: number,
  txnType: string,
  category: string | null = null,
  categoryId: number | null = null,
): Promise<number> {
  const txn = await models.Transaction.create({
    accountId,
    householdId: household.id,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'reporting-test',
    date,
    merchantRaw: 'Test merchant',
    merchantClean: 'Test merchant',
    amount: amount.toFixed(4),
    currency: 'CAD',
    txnType,
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: category,
    ...(categoryId != null ? { finalCategoryId: categoryId } : {}),
    autoBusiness: null,
    businessOverride: null,
    autoSplitType: null,
    splitOverride: null,
    autoPctMe: null,
    pctMeOverride: null,
    finalPctMe: null,
    autoPctPartner: null,
    pctPartnerOverride: null,
    finalPctPartner: null,
    reviewFlag: false,
    reviewedAt: null,
    createdByUserId: null,
  });
  return txn.id;
}

async function seedTxn(
  accountId: number,
  date: string,
  amount: number,
  txnType: string,
  category: string | null = null,
  categoryId: number | null = null,
): Promise<void> {
  await models.Transaction.create({
    accountId,
    householdId: household.id,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'reporting-test',
    date,
    merchantRaw: 'Test merchant',
    merchantClean: 'Test merchant',
    amount: amount.toFixed(4),
    currency: 'CAD',
    txnType,
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: category,
    // Only pin the id when given; otherwise let the beforeSave hook resolve the
    // name → root id (passing an explicit null would null the category instead).
    ...(categoryId != null ? { finalCategoryId: categoryId } : {}),
    autoBusiness: null,
    businessOverride: null,
    autoSplitType: null,
    splitOverride: null,
    autoPctMe: null,
    pctMeOverride: null,
    finalPctMe: null,
    autoPctPartner: null,
    pctPartnerOverride: null,
    finalPctPartner: null,
    reviewFlag: false,
    reviewedAt: null,
    createdByUserId: null,
  });
}

function isoDaysAgo(offset: number): string {
  const d = new Date(Date.now() - offset * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/** Checking account with $3k income + an investment account whose txn stream
 *  (transfer in, buys) leaves a meaningless +$2k residual while holdings are
 *  worth $100k. */
async function seedPortfolioFixture(): Promise<void> {
  const checking = await seedAccount('Chequing', 'checking');
  const brokerage = await seedAccount('Brokerage', 'investment');
  await seedTxn(checking, isoDaysAgo(10), 3000, 'income');
  await seedTxn(brokerage, isoDaysAgo(40), 80000, 'transfer');
  await seedTxn(brokerage, isoDaysAgo(35), -78000, 'investment');
  const sec = await models.Security.create({
    symbol: 'XEQT',
    name: 'XEQT',
    currency: 'CAD',
  } as never);
  await models.HoldingSnapshot.create({
    accountId: brokerage,
    securityId: sec.id,
    statementDate: isoDaysAgo(5),
    quantity: '1000',
    marketValue: '100000',
    currency: 'CAD',
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    importBatch: 'reporting-test',
  } as never);
}

/** A mistyped NON-investment account that has both a txn-stream balance and
 *  stray HoldingSnapshot rows (statement imported into the wrong account).
 *  Its holdings must not count on top of its txn balance — mirrors
 *  networth/aggregate's PORTFOLIO_DRIVEN_TYPES filter (PR #604). */
async function seedMistypedFixture(): Promise<void> {
  const checking = await seedAccount('Chequing', 'checking');
  await seedTxn(checking, isoDaysAgo(10), 3000, 'income');
  const sec = await models.Security.create({
    symbol: 'XEQT',
    name: 'XEQT',
    currency: 'CAD',
  } as never);
  await models.HoldingSnapshot.create({
    accountId: checking,
    securityId: sec.id,
    statementDate: isoDaysAgo(5),
    quantity: '500',
    marketValue: '50000',
    currency: 'CAD',
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    importBatch: 'reporting-test',
  } as never);
}

// ---- GET /tax -------------------------------------------------------------

test('GET /tax: grossIncome counts only txnType=income rows', async () => {
  const year = new Date().getFullYear();
  const checking = await seedAccount('Chequing', 'checking');
  await seedTxn(checking, `${year}-02-01`, 8000, 'income');
  // Brokerage sale proceeds, a refund, and an untyped deposit are NOT income —
  // same peel as /summary's summarizeReportingCashflow.
  await seedTxn(checking, `${year}-02-15`, 5000, 'investment');
  await seedTxn(checking, `${year}-03-01`, 500, 'refund');
  await seedTxn(checking, `${year}-03-05`, 1000, 'unknown');
  await seedTxn(checking, `${year}-03-10`, -200, 'purchase');

  const res = await request(app).get('/tax');
  assert.equal(res.status, 200);
  assert.equal(res.body.grossIncome, 8000);
  // Default reserve percent is 0.25.
  assert.equal(res.body.estimatedTaxOwed, 2000);
  assert.equal(res.body.taxReserveTarget, 2000);
});

// ---- GET /summary ----------------------------------------------------------

test('GET /summary: netWorth uses holdings market value for investment accounts', async () => {
  await seedPortfolioFixture();
  const res = await request(app).get('/summary');
  assert.equal(res.status, 200);
  // 3000 cash + 100000 portfolio — not 3000 + 2000 txn-stream residual.
  assert.equal(res.body.netWorth, 103000);
  assert.equal(res.body.liquidCash, 3000);
});

test('GET /summary: holdings on a non-investment account do not double-count', async () => {
  await seedMistypedFixture();
  const res = await request(app).get('/summary');
  assert.equal(res.status, 200);
  // The checking account already contributed its full txn-stream balance;
  // its stray holdings must not add another 50k on top.
  assert.equal(res.body.netWorth, 3000);
  assert.equal(res.body.liquidCash, 3000);
});

// ---- GET /projections -------------------------------------------------------

test('GET /projections: investment value comes from holdings market value', async () => {
  await seedPortfolioFixture();
  const res = await request(app).get('/projections');
  assert.equal(res.status, 200);
  const first = res.body.projections[0];
  assert.equal(first.projectedInvestments, 100000);
  assert.equal(first.projectedCash, 3000);
  assert.equal(first.projectedNetWorth, 103000);
});

test('GET /projections: holdings on a non-investment account are not investment value', async () => {
  await seedMistypedFixture();
  const res = await request(app).get('/projections');
  assert.equal(res.status, 200);
  const first = res.body.projections[0];
  assert.equal(first.projectedInvestments, 0);
  assert.equal(first.projectedNetWorth, 3000);
});

// ---- GET /cashflow/monthly ---------------------------------------------------

test('GET /cashflow/monthly: investment-account debits are not expenses', async () => {
  const checking = await seedAccount('Chequing', 'checking');
  const brokerage = await seedAccount('Brokerage', 'investment');
  await seedTxn(checking, '2026-04-10', -100, 'purchase', 'Groceries');
  await seedTxn(checking, '2026-04-25', 4000, 'income');
  // A brokerage debit whose narrative missed every detectTypeStage pattern
  // defaults to txnType='purchase' — accountType must exclude it.
  await seedTxn(brokerage, '2026-04-15', -5000, 'purchase');

  const res = await request(app).get('/cashflow/monthly?start=2026-04-01&end=2026-04-30');
  assert.equal(res.status, 200);
  const apr = res.body.months.find((m: { month: string }) => m.month === '2026-04');
  assert.ok(apr);
  assert.equal(apr.expenses, 100);
  assert.equal(apr.income, 4000);
});

// ---- GET /net-worth (weekly bucketing) --------------------------------------

test('GET /net-worth: weekly buckets use ISO weeks, no early-January W00 collapse', async () => {
  await seedAccount('Chequing', 'checking');
  // Range straddles the year boundary. The old ceil-based "ISO week" key put
  // Jan 1-3 in a bogus W00 bucket and split weeks at Saturday, producing
  // extra/duplicate buckets. With a stable Monday-start week key the four ISO
  // weeks in range resolve to their last in-range day (Sundays), in order.
  const res = await request(app).get('/net-worth?start=2025-12-22&end=2026-01-18&interval=week');
  assert.equal(res.status, 200);
  const dates = res.body.points.map((p: { date: string }) => p.date);
  assert.deepEqual(dates, ['2025-12-28', '2026-01-04', '2026-01-11', '2026-01-18']);
  // No bucket date may be a duplicate, and none collapses into a W00 artifact.
  assert.equal(new Set(dates).size, dates.length);
});

// ---- GET /spending/by-category ----------------------------------------------

test('GET /spending/by-category: investment-account debits are not category spend', async () => {
  const checking = await seedAccount('Chequing', 'checking');
  const brokerage = await seedAccount('Brokerage', 'investment');
  await seedTxn(checking, '2026-04-10', -100, 'purchase', 'Groceries');
  await seedTxn(brokerage, '2026-04-15', -5000, 'purchase');

  const res = await request(app).get('/spending/by-category?start=2026-04-01&end=2026-04-30');
  assert.equal(res.status, 200);
  assert.equal(res.body.categories.length, 1);
  assert.equal(res.body.categories[0].name, 'Groceries');
  assert.equal(res.body.categories[0].amount, 100);
  assert.equal(res.body.categories[0].percentage, 1);
});

test('GET /spending/by-category: a parent rolls up its child spend', async () => {
  const dining = await models.Category.create({ householdId: household.id, name: 'Dining', parentId: null });
  const coffee = await models.Category.create({ householdId: household.id, name: 'Coffee', parentId: dining.id });
  const chq = await seedAccount('Chq2', 'checking');
  await seedTxn(chq, '2026-04-05', -40, 'purchase', 'Dining', dining.id); // direct on parent
  await seedTxn(chq, '2026-04-06', -10, 'purchase', 'Coffee', coffee.id); // on child

  const res = await request(app).get('/spending/by-category?start=2026-04-01&end=2026-04-30');
  assert.equal(res.status, 200);
  const dRow = res.body.categories.find((c: { name: string }) => c.name === 'Dining');
  const cRow = res.body.categories.find((c: { name: string }) => c.name === 'Coffee');

  assert.equal(dRow.amount, 40);        // direct spend on Dining itself
  assert.equal(dRow.rolledAmount, 50);  // 40 + 10 from Coffee
  assert.equal(dRow.path, 'Dining');
  assert.equal(typeof dRow.categoryId, 'number');

  assert.equal(cRow.amount, 10);
  assert.equal(cRow.rolledAmount, 10);
  assert.equal(cRow.path, 'Dining / Coffee');
  assert.equal(cRow.parentId, dining.id);
});

test('GET /spending/by-category: accepted-linked itemized txn decomposes into per-item categories', async () => {
  // Two top-level categories for items from a single order.
  const groceries = await models.Category.create({ householdId: household.id, name: 'Groceries', parentId: null });
  const electronics = await models.Category.create({ householdId: household.id, name: 'Electronics', parentId: null });
  const chq = await seedAccount('ChqDecompose', 'checking');

  // Transaction A: $120 spend — linked to a two-item Amazon order ($80 groceries + $40 electronics).
  const txnAId = await seedTxnReturningId(chq, '2026-04-10', -120, 'purchase', 'Groceries', groceries.id);
  // Transaction B: $30 plain spend directly on Electronics (no link).
  await seedTxn(chq, '2026-04-12', -30, 'purchase', 'Electronics', electronics.id);

  // Seed the Amazon order: total=$120 CAD with two items.
  const order = await models.ExternalOrder.create({
    householdId: household.id,
    createdByUserId: null,
    vendor: 'amazon',
    vendorOrderId: 'TEST-ORDER-01',
    dedupeKey: 'test-order-decompose-01',
    orderDate: '2026-04-09',
    shipmentDate: null,
    subtotal: '120.0000',
    tax: '0.0000',
    shipping: '0.0000',
    total: '120.0000',
    currency: 'CAD',
    paymentLast4: null,
    source: 'test',
    rawPayload: null,
  });

  // Item 1: $80 Groceries. Supply ids directly to bypass the beforeSave hook (test isolation).
  await models.ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'Pantry item',
    quantity: 1,
    unitPrice: '80.0000',
    totalPrice: '80.0000',
    inferredCategory: 'Groceries',
    inferredCategoryId: groceries.id,
    categoryOverride: null,
    categoryOverrideId: null,
    businessUsePercent: null,
    businessUseOverride: null,
    displayName: null,
    displayNameConfidence: null,
    itemNumber: null,
    confidence: null,
    rawPayload: null,
  } as never);

  // Item 2: $40 Electronics.
  await models.ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'USB cable',
    quantity: 1,
    unitPrice: '40.0000',
    totalPrice: '40.0000',
    inferredCategory: 'Electronics',
    inferredCategoryId: electronics.id,
    categoryOverride: null,
    categoryOverrideId: null,
    businessUsePercent: null,
    businessUseOverride: null,
    displayName: null,
    displayNameConfidence: null,
    itemNumber: null,
    confidence: null,
    rawPayload: null,
  } as never);

  // Accept the link between txnA and the order.
  await models.TransactionOrderLink.create({
    transactionId: txnAId,
    externalOrderId: order.id,
    confidence: '1.00',
    matchReason: 'test',
    status: 'accepted',
    linkedAmount: null,
  });

  const res = await request(app).get('/spending/by-category?start=2026-04-01&end=2026-04-30');
  assert.equal(res.status, 200);

  const gRow = res.body.categories.find((c: { name: string }) => c.name === 'Groceries');
  const eRow = res.body.categories.find((c: { name: string }) => c.name === 'Electronics');

  // (a) Mixed txn ($120) decomposes: $80 → Groceries, $40 → Electronics.
  // gRow gets the $80 item allocation from txnA (txnA was categorised as Groceries,
  // but item decomposition overrides it to item-level).
  assert.ok(gRow, 'Groceries row must exist');
  assert.ok(eRow, 'Electronics row must exist');
  assert.equal(gRow.amount, 80);
  // Electronics gets $40 from txnA item + $30 from txnB plain = $70.
  assert.equal(eRow.amount, 70);

  // (b) Invariant: sum of all category direct amounts equals sum of all transaction spend.
  const totalCategorySpend = res.body.categories
    .filter((c: { name: string }) => c.name !== 'Uncategorized')
    .reduce((s: number, c: { amount: number }) => s + c.amount, 0);
  // Two transactions: $120 + $30 = $150.
  assert.equal(Math.round(totalCategorySpend * 100), 15000);
});
