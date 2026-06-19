/**
 * Integration tests for GET /api/summary/period-insight. Verifies the
 * PERIOD-SCOPED decomposition of a window's net-spend into realCost + owedBack,
 * the owedBack flow sourced from both partner shares and reimbursable claims,
 * the "where the money moved" breakdown totals, and the date-validation guards.
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
  counterpartyContactId?: number | null;
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
    counterpartyContactId: seed.counterpartyContactId ?? null,
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
        owedBackBreakdown: { reimbursable: number; partnerShare: number };
        totalSpend: number;
        totalCredits: number;
        totalIncome: number;
        totalPayments: number;
      }
    | undefined;
  assert.ok(cad, `expected a CAD entry: ${JSON.stringify(res.body.byCurrency)}`);
  assert.equal(cad.netSpend, 100, 'netSpend = totalSpend - totalCredits');
  assert.equal(cad.owedBack, 40, 'owedBack = partner share of the shared txn');
  assert.equal(cad.realCost, 60, 'realCost = netSpend - owedBack');
  assert.equal(cad.owedBackBreakdown.partnerShare, 40);
  assert.equal(cad.owedBackBreakdown.reimbursable, 0);

  // "Where the money moved" breakdown totals are present and self-consistent
  // (netSpend = totalSpend - totalCredits). The lone -100 spend row gives
  // totalSpend 100, no credits/income/payments.
  assert.equal(typeof cad.totalSpend, 'number');
  assert.equal(typeof cad.totalCredits, 'number');
  assert.equal(typeof cad.totalIncome, 'number');
  assert.equal(typeof cad.totalPayments, 'number');
  assert.equal(cad.totalSpend, 100);
  assert.equal(cad.totalCredits, 0);
  assert.equal(cad.netSpend, cad.totalSpend - cad.totalCredits);
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
  }>).find((c) => c.currency === 'CAD');
  assert.ok(cad);
  assert.equal(cad.netSpend, 100);
  assert.equal(cad.owedBack, 50, 'reimbursable 50 wins, partner 30 ignored');
  assert.equal(cad.realCost, 50);
  assert.equal(cad.owedBackBreakdown.reimbursable, 50);
  assert.equal(cad.owedBackBreakdown.partnerShare, 0);
});

test('missing dates return 400', async () => {
  const res = await agentA.get('/api/summary/period-insight').query({ currency: 'CAD' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'dateFrom and dateTo are required' });
});

test('malformed dates return 400, not 500', async () => {
  // dateFrom is a syntactically-non-ISO date string (month 13, day 99). The
  // handler's shape guard (ISO_DATE regex) must map this to a clean 400 (a
  // client error) — NOT propagate to a 500. Presence is satisfied (both params
  // present), so this exercises the SHAPE guard, not the presence guard.
  const res = await agentA
    .get('/api/summary/period-insight')
    .query({ currency: 'CAD', dateFrom: '2026-13-99', dateTo: '2026-13-31' });
  assert.equal(res.status, 400, `expected 400 for malformed dates, got ${res.status}`);
  assert.deepEqual(res.body, { error: 'invalid date' });
});

test('peerLending splits non-partner transfers, excludes partners + non-loan categories', async () => {
  const models = await import('../../src/models');
  const friend = await models.Contact.create({ householdId: householdAId, name: 'Lend Friend' });
  const partner = await models.Contact.create({
    householdId: householdAId,
    name: 'Lend Partner',
    isPartner: true,
  });

  // Non-partner: lent 500, received 200 back (both inside the window).
  await createTxn({
    householdId: householdAId, accountId: accountAId, date: '2026-08-05',
    amount: -500, currency: 'CAD', merchantRaw: 'Cash sent', txnType: 'transfer',
    counterpartyContactId: friend.id,
  });
  await createTxn({
    householdId: householdAId, accountId: accountAId, date: '2026-08-12',
    amount: 200, currency: 'CAD', merchantRaw: 'Cash received', txnType: 'transfer',
    counterpartyContactId: friend.id,
  });
  // Partner transfer — excluded.
  await createTxn({
    householdId: householdAId, accountId: accountAId, date: '2026-08-08',
    amount: -1000, currency: 'CAD', merchantRaw: 'Cash sent', txnType: 'transfer',
    counterpartyContactId: partner.id,
  });
  // Non-loan category (rent) to the friend — excluded.
  await createTxn({
    householdId: householdAId, accountId: accountAId, date: '2026-08-09',
    amount: -300, currency: 'CAD', merchantRaw: 'Rent', finalCategory: 'rent',
    txnType: 'transfer', counterpartyContactId: friend.id,
  });

  const res = await agentA
    .get('/api/summary/period-insight')
    .query({ currency: 'CAD', dateFrom: '2026-08-01', dateTo: '2026-08-31' });
  assert.equal(res.status, 200);
  const cad = (res.body.byCurrency as Array<{
    currency: string;
    peerLending: { lent: number; received: number };
  }>).find((c) => c.currency === 'CAD');
  assert.ok(cad, `expected CAD entry: ${JSON.stringify(res.body.byCurrency)}`);
  assert.equal(cad.peerLending.lent, 500, 'only the non-partner, non-rent send counts');
  assert.equal(cad.peerLending.received, 200);
});
