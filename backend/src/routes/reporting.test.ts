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

async function seedTxn(
  accountId: number,
  date: string,
  amount: number,
  txnType: string,
  category: string | null = null,
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
