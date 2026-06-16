/**
 * Integration tests for GET /api/summary/period-insight (Task 8 of the
 * dashboard period-insight band). Verifies the end-to-end decomposition of a
 * window's net-spend into realCost + owedBack, range-kind detection, and the
 * owedBack flow sourced from both partner shares and reimbursable claims.
 *
 * Harness mirrors `summary.test.ts`: one isolated Postgres DB, a bootstrap
 * superadmin, and one non-superadmin household (A) seeded via `seedHousehold`
 * with its own session-cookie supertest agent. Fixtures are hand-built rows
 * written via `Transaction.create` / `Reimbursement.create`.
 *
 * Needs Postgres (`TEST_DATABASE_URL`); runs via the `test:integration` runner.
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
let householdAId: number;
let userAId: number;
let accountAId: number;
let testDb: PgTestDb;

type TxnSeed = {
  householdId: number;
  accountId: number;
  date: string;
  amount: number;
  currency?: string;
  merchantRaw?: string;
  finalCategory?: string | null;
  finalSplitType?: string;
  partnerShareAmount?: number;
  myShareAmount?: number;
  txnType?: string;
};

async function createTxn(seed: TxnSeed): Promise<number> {
  const models = await import('../../src/models');
  const row = await models.Transaction.create({
    accountId: seed.accountId,
    householdId: seed.householdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'period-insight-test',
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
    finalCategory: seed.finalCategory ?? null,
    autoBusiness: null,
    businessOverride: null,
    finalBusiness: false,
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
    businessAmount: '0',
    txnType: seed.txnType ?? 'purchase',
    autoSource: null,
    autoConfidence: null,
    linkedTransactionId: null,
    isRecurring: false,
    reviewFlag: false,
    reviewedAt: null,
    createdByUserId: null,
  });
  return row.id;
}

before(async () => {
  process.env.NODE_ENV = 'test';

  testDb = await setupPgTestDb('period_insight');

  const mod = await import('../../src/app.js');
  app = mod.default;

  superAgent = request.agent(app);
  const register = await superAgent.post('/api/auth/register').send({
    email: 'super-period-insight@example.com',
    displayName: 'Super Period Insight',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const a = await seedHousehold('PeriodInsightA', 'A Partner');
  householdAId = a.householdId;
  userAId = a.userId;
  agentA = request.agent(app);
  agentA.jar.setCookie(`cashflow_session=${a.token}; Path=/`);

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
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('decomposes net spend into realCost + owedBack from a partner share', async () => {
  // -100 CAD purchase with -40 partner share, dated inside May 2026.
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-05-12',
    amount: -100,
    currency: 'CAD',
    finalCategory: 'Groceries',
    merchantRaw: 'Shared Grocer',
    finalSplitType: 'shared',
    myShareAmount: -60,
    partnerShareAmount: -40,
  });

  const res = await agentA
    .get('/api/summary/period-insight')
    .query({ currency: 'CAD', dateFrom: '2026-05-01', dateTo: '2026-05-31' });
  assert.equal(res.status, 200);

  const cad = (res.body.byCurrency as Array<{ currency: string }>).find(
    (c) => c.currency === 'CAD',
  ) as
    | {
        currency: string;
        netSpend: number;
        owedBack: number;
        realCost: number;
        rangeKind: string;
        owedBackBreakdown: { reimbursable: number; partnerShare: number };
      }
    | undefined;
  assert.ok(cad, `expected a CAD entry: ${JSON.stringify(res.body.byCurrency)}`);
  assert.equal(cad.netSpend, 100, 'netSpend = totalSpend - totalCredits');
  assert.equal(cad.owedBack, 40, 'owedBack = partner share of the shared txn');
  assert.equal(cad.realCost, 60, 'realCost = netSpend - owedBack');
  assert.equal(cad.rangeKind, 'calendar-month', 'full May 2026 is a calendar month');
  assert.equal(cad.owedBackBreakdown.partnerShare, 40);
  assert.equal(cad.owedBackBreakdown.reimbursable, 0);
});

test('reimbursable claim wins over partner share on the same txn (dedup)', async () => {
  // A June txn that is both partner-split (-30) and reimbursable (50): the
  // reimbursable claim wins and partner share is ignored for owedBack.
  const txnId = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-06-10',
    amount: -100,
    currency: 'CAD',
    finalCategory: 'Dining',
    merchantRaw: 'Reimbursed Dinner',
    finalSplitType: 'shared',
    myShareAmount: -70,
    partnerShareAmount: -30,
  });
  const models = await import('../../src/models');
  await models.Reimbursement.create({
    householdId: householdAId,
    transactionId: txnId,
    contactId: null,
    partyName: 'Employer',
    amount: '50.0000',
    currency: 'CAD',
    dueDate: null,
    status: 'expected',
    repaymentTransactionId: null,
    receivedAt: null,
    createdByUserId: userAId,
    notes: null,
  });

  const res = await agentA
    .get('/api/summary/period-insight')
    .query({ currency: 'CAD', dateFrom: '2026-06-01', dateTo: '2026-06-30' });
  assert.equal(res.status, 200);
  const cad = (res.body.byCurrency as Array<{
    currency: string;
    netSpend: number;
    owedBack: number;
    realCost: number;
    owedBackBreakdown: { reimbursable: number; partnerShare: number };
    receivablesOutstanding: number;
  }>).find((c) => c.currency === 'CAD');
  assert.ok(cad);
  assert.equal(cad.netSpend, 100);
  assert.equal(cad.owedBack, 50, 'reimbursable 50 wins, partner 30 ignored');
  assert.equal(cad.realCost, 50);
  assert.equal(cad.owedBackBreakdown.reimbursable, 50);
  assert.equal(cad.owedBackBreakdown.partnerShare, 0);
  // Outstanding stock reflects the still-expected claim (all-time).
  assert.ok(
    cad.receivablesOutstanding >= 50,
    `expected outstanding to include the open claim: ${cad.receivablesOutstanding}`,
  );
});

test('missing dates return 400', async () => {
  const res = await agentA.get('/api/summary/period-insight').query({ currency: 'CAD' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'dateFrom and dateTo are required' });
});

test('typical baseline omitted when fewer than minRequired populated months', async () => {
  // NOTE: period-insight loads windows household-scoped (NOT account-scoped), so
  // a "fresh account" does NOT isolate the trailing window — every prior fixture
  // on household A counts. We therefore query a FAR-FUTURE month (March 2030)
  // whose trailing-12 typical window (March 2029 … Feb 2030) is clear of all
  // earlier fixtures (2026–2028), then seed exactly the months we control.
  //
  // Seed the main window (March 2030) so the per-currency loop runs at all, plus
  // exactly TWO distinct trailing months (Feb 2030 + Jan 2030). The main window
  // is NOT itself a typical window, so populatedCount = 2 < min 3 → `typical`
  // must be omitted, while `prior-period` (Feb 2030) is still present.
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2030-03-10',
    amount: -50,
    currency: 'CAD',
    finalCategory: 'Groceries',
    merchantRaw: 'Mar Grocer',
  });
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2030-02-10',
    amount: -40,
    currency: 'CAD',
    finalCategory: 'Groceries',
    merchantRaw: 'Feb Grocer',
  });
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2030-01-15',
    amount: -30,
    currency: 'CAD',
    finalCategory: 'Groceries',
    merchantRaw: 'Jan Grocer',
  });

  const res = await agentA
    .get('/api/summary/period-insight')
    .query({ currency: 'CAD', dateFrom: '2030-03-01', dateTo: '2030-03-31' });
  assert.equal(res.status, 200);
  const cad = (res.body.byCurrency as Array<{
    currency: string;
    baselines: Array<{ key: string }>;
  }>).find((c) => c.currency === 'CAD');
  assert.ok(cad, `expected a CAD entry: ${JSON.stringify(res.body.byCurrency)}`);
  const keys = cad.baselines.map((b) => b.key);
  assert.ok(
    !keys.includes('typical'),
    `typical must be omitted with only 2 populated months (< min 3): ${JSON.stringify(keys)}`,
  );
  assert.ok(
    keys.includes('prior-period'),
    `prior-period (Feb 2030) should still be present: ${JSON.stringify(keys)}`,
  );
});

test('typical baseline present and averaged over populated months only', async () => {
  // Far-future again, clear of every prior fixture. Query Dec 2031; its trailing
  // window is Dec 2030 … Nov 2031. Seed the main window (Dec 2031) so the
  // per-currency loop runs, plus exactly THREE distinct trailing months
  // (Nov/Oct/Sep 2031) with -60/-30/-90 realCost (no owedBack). populatedCount =
  // 3 >= min 3, so `typical` is present and its realCost = (60+30+90)/3 = 60 —
  // averaged over the 3 POPULATED months, NOT diluted across the 12-window span
  // (the pre-fix bug would have divided by 12, giving 15).
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2031-12-05',
    amount: -10,
    currency: 'CAD',
    finalCategory: 'Groceries',
    merchantRaw: 'Dec Main Grocer',
  });
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2031-11-05',
    amount: -60,
    currency: 'CAD',
    finalCategory: 'Groceries',
    merchantRaw: 'Nov Grocer',
  });
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2031-10-05',
    amount: -30,
    currency: 'CAD',
    finalCategory: 'Groceries',
    merchantRaw: 'Oct Grocer',
  });
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2031-09-05',
    amount: -90,
    currency: 'CAD',
    finalCategory: 'Groceries',
    merchantRaw: 'Sep Grocer',
  });

  const res = await agentA
    .get('/api/summary/period-insight')
    .query({ currency: 'CAD', dateFrom: '2031-12-01', dateTo: '2031-12-31' });
  assert.equal(res.status, 200);
  const cad = (res.body.byCurrency as Array<{
    currency: string;
    baselines: Array<{ key: string; realCost: number; owedBack: number }>;
  }>).find((c) => c.currency === 'CAD');
  assert.ok(cad, `expected a CAD entry: ${JSON.stringify(res.body.byCurrency)}`);
  const typical = cad.baselines.find((b) => b.key === 'typical');
  assert.ok(
    typical,
    `typical must be present with 3 populated months (>= min 3): ${JSON.stringify(
      cad.baselines.map((b) => b.key),
    )}`,
  );
  assert.equal(
    typical.realCost,
    60,
    'realCost = (60+30+90)/3 averaged over populated months only',
  );
  assert.equal(typical.owedBack, 0);
});

test('malformed dates return 400, not 500', async () => {
  // dateFrom is a syntactically-ISO-but-impossible date (month 13, day 99); the
  // pure range helpers in periodRanges.ts THROW a RangeValidationError, which
  // the handler must map to a clean 400 (a client error) — NOT propagate to a
  // 500 (server fault). Presence is satisfied (both params present), so this
  // exercises the SHAPE guard, not the presence guard.
  const res = await agentA
    .get('/api/summary/period-insight')
    .query({ currency: 'CAD', dateFrom: '2026-13-99', dateTo: '2026-13-31' });
  assert.equal(res.status, 400, `expected 400 for malformed dates, got ${res.status}`);
  assert.ok(
    typeof res.body.error === 'string' && /invalid|range/i.test(res.body.error),
    `expected a validation error message: ${JSON.stringify(res.body)}`,
  );
});

test('an inverted range (to < from) returns 400', async () => {
  // Well-formed but inverted endpoints — the range guard throws, must surface 400.
  const res = await agentA
    .get('/api/summary/period-insight')
    .query({ currency: 'CAD', dateFrom: '2026-05-31', dateTo: '2026-05-01' });
  assert.equal(res.status, 400, `expected 400 for inverted range, got ${res.status}`);
  assert.ok(
    typeof res.body.error === 'string' && /range|before|inverted/i.test(res.body.error),
    `expected an inverted-range error message: ${JSON.stringify(res.body)}`,
  );
});

test('typical span-bucketing places rows in the right trailing windows', async () => {
  // Fix 2 regression guard: the trailing-12 typical windows are now loaded with
  // ONE span query and bucketed in memory by date. Seed FOUR populated trailing
  // months whose realCosts are distinct (so a mis-bucket would change the mean),
  // in a far-future window clear of every other fixture. Query Dec 2033; trailing
  // window is Dec 2032 … Nov 2033. Seed main (Dec 2033) + Nov/Oct/Sep/Aug 2033 at
  // -40/-20/-60/-80 → typical realCost = (40+20+60+80)/4 = 50. If the bucketer
  // dropped or merged a window, the mean would diverge from 50.
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2033-12-05',
    amount: -10,
    currency: 'CAD',
    finalCategory: 'Groceries',
    merchantRaw: 'Dec Main 2033',
  });
  for (const [date, amount] of [
    ['2033-11-05', -40],
    ['2033-10-05', -20],
    ['2033-09-05', -60],
    ['2033-08-05', -80],
  ] as Array<[string, number]>) {
    await createTxn({
      householdId: householdAId,
      accountId: accountAId,
      date,
      amount,
      currency: 'CAD',
      finalCategory: 'Groceries',
      merchantRaw: `Bucket ${date}`,
    });
  }

  const res = await agentA
    .get('/api/summary/period-insight')
    .query({ currency: 'CAD', dateFrom: '2033-12-01', dateTo: '2033-12-31' });
  assert.equal(res.status, 200);
  const cad = (res.body.byCurrency as Array<{
    currency: string;
    baselines: Array<{ key: string; realCost: number }>;
  }>).find((c) => c.currency === 'CAD');
  assert.ok(cad, `expected a CAD entry: ${JSON.stringify(res.body.byCurrency)}`);
  const typical = cad.baselines.find((b) => b.key === 'typical');
  assert.ok(
    typical,
    `typical must be present with 4 populated months: ${JSON.stringify(
      cad.baselines.map((b) => b.key),
    )}`,
  );
  assert.equal(
    typical.realCost,
    50,
    'realCost = (40+20+60+80)/4 — windows bucketed correctly from one span query',
  );
});

test('a custom (partial-month) range is detected as rangeKind custom', async () => {
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-07-15',
    amount: -20,
    currency: 'CAD',
    finalCategory: 'Dining',
    merchantRaw: 'Mid-month Cafe',
  });
  const res = await agentA
    .get('/api/summary/period-insight')
    .query({ currency: 'CAD', dateFrom: '2026-07-10', dateTo: '2026-07-20' });
  assert.equal(res.status, 200);
  const cad = (res.body.byCurrency as Array<{ currency: string; rangeKind: string }>).find(
    (c) => c.currency === 'CAD',
  );
  assert.ok(cad);
  assert.equal(cad.rangeKind, 'custom');
});
