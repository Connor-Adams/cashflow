/**
 * Integration: imports a fixture WS bundle via /api/import/upload-bundle,
 * then hits /api/summary/dashboard and asserts totalSpend excludes the
 * investment-buy cash legs and the chequing → invest transfers.
 *
 * Pre-PR-#59 every negative-amount BUY/AFT_OUT/CONT row was stamped
 * `txnType='purchase'` and summed into totalSpend, inflating the user's
 * reported personal spend ~10x. This test guards that regression.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const csvUploadDir = path.join(backendRoot, 'uploads', 'test-ws-spend-csv');
const receiptsUploadDir = path.join(backendRoot, 'uploads', 'test-ws-spend-receipts');

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let testDb: PgTestDb;

before(async () => {
  fs.mkdirSync(csvUploadDir, { recursive: true });
  fs.rmSync(receiptsUploadDir, { recursive: true, force: true });
  fs.mkdirSync(receiptsUploadDir, { recursive: true });

  process.env.CSV_UPLOAD_DIR = csvUploadDir;
  process.env.RECEIPTS_UPLOAD_DIR = receiptsUploadDir;

  testDb = await setupPgTestDb('ws-spend');

  const mod = await import('../../src/app.js');
  app = mod.default;
  authed = testAgent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'ws-spend@example.com',
    displayName: 'WS Spend User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
});

after(async () => {
  await teardownPgTestDb(testDb);
  fs.rmSync(receiptsUploadDir, { recursive: true, force: true });
});

// Crafted CSVs that exercise every txnType the fix touches.
//
// Chequing file mixes:
//   - AFT_OUT (transfer)         -2000   → must NOT count as spend
//   - AFT_IN (transfer)           5000   → income, not spend
//   - Bill payment (purchase)     -150   → counts as spend
//   - CONT (transfer to invest)   -3000  → must NOT count as spend
const CHEQUING_CSV = `"date","transaction","description","amount","balance","currency"
"2025-06-02","AFT_IN","Direct deposit from EMPLOYER","5000","5000","CAD"
"2025-06-03","AFT_OUT","Pre-authorized Debit to AMEX BILL PYMT","-2000","3000","CAD"
"2025-06-05","EFT","Hydro bill payment","-150","2850","CAD"
"2025-06-10","CONT","Transfer to Wealthsimple Investing","-3000","-150","CAD"
`;

// Invest file (TFSA: accountType=investment in WS_ACCOUNT_TEMPLATES, so
// negative amounts here are excluded from spend regardless of txnType
// per the belt-and-suspenders invest-account rule).
//   - BUY (investment)            -2500  → must NOT count as spend
//   - SELL (investment)            500   → not consumption either way
//   - DIV (dividend)                10   → dividend credit
//   - FEE (fee, but on invest acct) -5   → excluded by invest-account rule
const INVEST_CSV = `"date","transaction","description","amount","balance","currency"
"2025-06-10","BUY","XEQT - iShares Core Equity ETF Portfolio: Bought 100 shares (executed at 2025-06-10)","-2500","-2500","CAD"
"2025-06-15","SELL","VFV - Vanguard S&P 500 ETF: Sold 5 shares at $100.00 per share (executed at 2025-06-15)","500","-2000","CAD"
"2025-06-20","DIV","VFV - Vanguard S&P 500 ETF: Cash dividend distribution, received on 2025-06-20","10","-1990","CAD"
"2025-06-25","FEE","Subscription fee paid for period 2025-06-01 to 2025-06-30","-5","-1995","CAD"
`;

type BundleResult = {
  file: string;
  wsid: string | null;
  accountId: number | null;
  insertedTransactions: number;
};

test('WS bundle import + /api/summary/dashboard: totalSpend excludes transfers and investment buys', async () => {
  const upload = await authed
    .post('/api/import/upload-bundle')
    .attach('files', Buffer.from(CHEQUING_CSV, 'utf8'), {
      filename: 'Chequing-2025-06-01-monthly-statement-transactions-WK3DD9X35CAD.csv',
      contentType: 'text/csv',
    })
    .attach('files', Buffer.from(INVEST_CSV, 'utf8'), {
      filename: 'TFSA-2025-06-01-monthly-statement-transactions-HQ6LMLTK8CAD.csv',
      contentType: 'text/csv',
    });
  assert.equal(upload.status, 200, `upload body=${JSON.stringify(upload.body)}`);
  const results = upload.body.results as BundleResult[];
  assert.equal(results.length, 2);
  for (const r of results) {
    assert.ok(r.insertedTransactions > 0, `expected inserts for ${r.file}, got ${JSON.stringify(r)}`);
  }

  // === The actual fix assertion ===
  const dash = await authed.get('/api/summary/dashboard').query({ currency: 'CAD' });
  assert.equal(dash.status, 200, `dash body=${JSON.stringify(dash.body)}`);

  const metrics = (dash.body.metricsByCurrency as Array<{
    currency: string;
    totalSpend: number;
    totalCredits: number;
    totalPayments: number;
    netSpend: number;
    transactionCount: number;
  }>).find((m) => m.currency === 'CAD');
  assert.ok(metrics, `expected CAD metrics: ${JSON.stringify(dash.body.metricsByCurrency)}`);

  // Only the chequing bill payment (-150) contributes to spend. The
  // pre-fix bug also counted AFT_OUT (-2000), CONT (-3000), and BUY
  // (-2500), inflating totalSpend by 7500. The FEE -5 lives on the TFSA
  // (investment account) and is excluded by the belt-and-suspenders
  // invest-account rule.
  assert.equal(
    metrics.totalSpend,
    150,
    `expected totalSpend=150, got ${metrics.totalSpend} — transfers/investments leaked`,
  );

  // Positive-side reconciliation. AFT_IN +5000 (chequing transfer),
  // SELL +500 (invest), DIV +10 (invest) are all non-categorical money
  // flows — none of them is a refund, statement payment, or income
  // credit against spend. They must NOT appear in totalCredits or
  // totalPayments, and netSpend must reconcile to totalSpend.
  // Pre-fix: totalCredits leaked all three ($5510) because the headline
  // positive branch didn't apply isNonCategorical / accountType filters,
  // dragging netSpend negative (~-5360).
  assert.equal(
    metrics.totalCredits,
    0,
    `expected totalCredits=0, got ${metrics.totalCredits} — transfer/investment positives leaked into credits`,
  );
  assert.equal(
    metrics.totalPayments,
    0,
    `expected totalPayments=0, got ${metrics.totalPayments} — transfer/investment positives leaked into payments`,
  );
  assert.equal(
    metrics.netSpend,
    150,
    `expected netSpend=150 (= totalSpend), got ${metrics.netSpend} — credits leakage broke reconciliation`,
  );

  // Headline reconciles with business+personal sum: with no credit leakage,
  // sum of per-bucket netSpend across business/personal/etc must equal
  // headline netSpend. Pre-fix divergence was the central symptom.
  const business = (dash.body.netSpendByBusiness as Array<{
    currency: string;
    business: boolean;
    netSpend: number;
  }>).filter((b) => b.currency === 'CAD');
  const bizSum = business.reduce((s, b) => s + b.netSpend, 0);
  assert.equal(
    bizSum,
    metrics.netSpend,
    `business+personal netSpend (${bizSum}) must equal headline netSpend (${metrics.netSpend})`,
  );

  // None of the per-merchant breakdowns should contain a "transfer" line
  // labelled with an inflated spend.
  const merchantSummaries = dash.body.merchantSummaries as Array<{
    merchant: string;
    totalSpend: number;
  }>;
  const aftMerchant = merchantSummaries.find((m) =>
    /pre-authorized debit/i.test(m.merchant) || /direct deposit/i.test(m.merchant),
  );
  if (aftMerchant) {
    assert.equal(
      aftMerchant.totalSpend,
      0,
      `AFT_OUT merchant should not contribute to spend, got ${aftMerchant.totalSpend}`,
    );
  }

  // Account-level spend on the TFSA (invest account) should be 0 —
  // every row is non-spend (BUY/SELL/DIV/FEE on an invest account).
  // Pre-fix this would have been -2505 (BUY + FEE).
  const accountSummaries = dash.body.accountSummaries as Array<{
    accountName: string;
    totalSpend: number;
  }>;
  const tfsaSummary = accountSummaries.find((a) => /tfsa/i.test(a.accountName));
  assert.ok(tfsaSummary, `expected TFSA account summary: ${JSON.stringify(accountSummaries)}`);
  assert.equal(
    tfsaSummary.totalSpend,
    0,
    `TFSA spend should be 0 (all invest-account rows excluded); got ${tfsaSummary.totalSpend}`,
  );
});

test('/api/ai/insights: investment buys + transfers excluded from Uncategorized spend totals', async () => {
  const insights = await authed
    .get('/api/ai/insights')
    .query({ currency: 'CAD', dateFrom: '2025-06-01', dateTo: '2025-06-30' });
  assert.equal(insights.status, 200, `insights body=${JSON.stringify(insights.body)}`);

  type Insight = {
    title: string;
    metric: string;
    amount: number;
    comparison: string;
  };
  const list = insights.body.insights as Insight[];

  // Pre-fix: the TFSA BUY (-2500) and any other negative non-spend rows
  // landed in byCategory.get('Uncategorized') because the insights loop
  // never consulted accountType or txnType. Post-fix: applying isNonSpend
  // means BUY is excluded from spend → Uncategorized spend bucket holds
  // ONLY genuine spend rows whose finalCategory is null (none, in this
  // fixture, since the enricher categorizes the hydro bill).
  const uncatSpend = list.find((i) => i.metric === 'uncategorized_spend');
  if (uncatSpend) {
    assert.ok(
      uncatSpend.amount < 2500,
      `Uncategorized spend (${uncatSpend.amount}) should not include the $2500 TFSA BUY (txnType=investment, investment account)`,
    );
  }

  // The "Top category" insight, when present, must not name a category
  // whose total is inflated by non-spend rows. With this fixture the only
  // surviving spend is the chequing hydro bill ($150), so any topCategory
  // amount must be ≤ 150.
  const top = list.find((i) => i.metric === 'category_spend');
  if (top) {
    assert.ok(
      top.amount <= 150,
      `Top category spend (${top.amount}) exceeds the only legitimate spend row ($150) — non-spend rows leaked`,
    );
  }
});

test('/api/summary/monthly: investment buys + transfers excluded from monthly curve', async () => {
  const monthly = await authed.get('/api/summary/monthly').query({ currency: 'CAD' });
  assert.equal(monthly.status, 200);
  const point = (monthly.body.points as Array<{
    month: string;
    currency: string;
    sumAmount: number;
  }>).find((p) => p.month === '2025-06' && p.currency === 'CAD');
  assert.ok(point, `expected 2025-06 CAD point: ${JSON.stringify(monthly.body)}`);
  // sumAmount = sum of signed amounts after exclusion. Surviving rows:
  //   -150 (chequing bill) — that's the only spend row. Transfers, BUY,
  //   SELL, DIV, and even the invest-account FEE are all excluded.
  assert.equal(
    point.sumAmount,
    -150,
    `expected sumAmount=-150, got ${point.sumAmount} — non-spend leaked into /monthly`,
  );
});
