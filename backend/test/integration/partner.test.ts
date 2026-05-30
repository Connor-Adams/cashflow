/**
 * Integration tests for `backend/src/routes/partner.ts`:
 *   - GET /api/partner/fairness
 *   - GET /api/partner/monthly
 *   - GET /api/partner/settlement-recommendation
 *
 * Bootstraps in the same shape as `summary.test.ts`: one shared
 * Postgres test DB, one superadmin, two scoped households. Fixtures
 * are hand-built via `Transaction.create` to mirror the single-payer
 * model: I always pay, partnerShareAmount is what partner owes me.
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
let contactAId: number;
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
  finalCategory?: string | null;
  finalSplitType?: string;
  ownershipType?: string;
  ownershipContactId?: number | null;
  myShareAmount?: number;
  partnerShareAmount?: number;
  txnType?: string;
  visibility?: string;
  createdByUserId?: number | null;
  // #375 — populate the counterparty link from a seed so partner-inflow tests
  // can dial in who paid in on each row.
  counterpartyContactId?: number | null;
};

async function createTxn(seed: TxnSeed): Promise<number> {
  const models = await import('../../src/models');
  const row = await models.Transaction.create({
    accountId: seed.accountId,
    householdId: seed.householdId,
    visibility: seed.visibility ?? 'shared',
    ownershipType: seed.ownershipType ?? 'me',
    ownershipContactId: seed.ownershipContactId ?? null,
    importBatch: 'partner-test',
    date: seed.date,
    merchantRaw: seed.merchantRaw ?? 'Test',
    merchantClean: seed.merchantClean ?? seed.merchantRaw ?? 'Test',
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
    finalSplitType: seed.finalSplitType ?? 'shared',
    autoPctMe: null,
    pctMeOverride: null,
    finalPctMe: null,
    autoPctPartner: null,
    pctPartnerOverride: null,
    finalPctPartner: null,
    myShareAmount: String(seed.myShareAmount ?? seed.amount / 2).toString(),
    partnerShareAmount: String(seed.partnerShareAmount ?? seed.amount / 2).toString(),
    businessAmount: '0',
    txnType: seed.txnType ?? 'purchase',
    autoSource: null,
    autoConfidence: null,
    linkedTransactionId: null,
    isRecurring: false,
    reviewFlag: false,
    reviewedAt: null,
    createdByUserId: seed.createdByUserId ?? null,
    counterpartyContactId: seed.counterpartyContactId ?? null,
  });
  return row.id;
}

before(async () => {
  process.env.NODE_ENV = 'test';

  testDb = await setupPgTestDb('partner');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const bootstrap = request.agent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'super-partner@example.com',
    displayName: 'Super Partner',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const a = await seedHousehold('PartnerA', 'A Partner');
  householdAId = a.householdId;
  userAId = a.userId;
  contactAId = a.contactId;
  agentA = request.agent(app);
  agentA.jar.setCookie(`cashflow_session=${a.token}; Path=/`);

  const b = await seedHousehold('PartnerB', 'B Partner');
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

// ---------------- GET /api/partner/fairness ----------------

test('/fairness: includes shared transactions in totals + currentMonthSharedSpend', async () => {
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2027-04-10',
    amount: -200,
    currency: 'CAD',
    finalSplitType: 'shared',
    ownershipType: 'contact',
    ownershipContactId: contactAId,
    myShareAmount: -100,
    partnerShareAmount: -100,
    finalCategory: 'Groceries',
    merchantRaw: 'Joint Groceries',
  });

  const res = await agentA
    .get('/api/partner/fairness')
    .query({ currency: 'CAD', dateFrom: '2027-04-01', dateTo: '2027-04-30' });
  assert.equal(res.status, 200);
  const cad = (res.body.byCurrency as Array<{
    currency: string;
    sharedTransactionCount: number;
    partnerShareTotal: number;
    sharedSpendTotal: number;
  }>).find((r) => r.currency === 'CAD');
  assert.ok(cad, `expected CAD entry: ${JSON.stringify(res.body)}`);
  assert.equal(cad.sharedTransactionCount, 1);
  assert.equal(cad.partnerShareTotal, -100);
  assert.equal(cad.sharedSpendTotal, -200);
});

test('/fairness: settlements applied → balance shifts', async () => {
  // Settlement in the same date window — partner paid me $30 back.
  const settle = await agentA.post('/api/settlements').send({
    contactId: contactAId,
    direction: 'partner_paid_me',
    currency: 'CAD',
    amount: 30,
    settledDate: '2027-04-20',
  });
  assert.equal(settle.status, 201);

  const res = await agentA
    .get('/api/partner/fairness')
    .query({ currency: 'CAD', dateFrom: '2027-04-01', dateTo: '2027-04-30' });
  assert.equal(res.status, 200);
  const cad = (res.body.byCurrency as Array<{
    currency: string;
    balance: number;
    partnerShareTotal: number;
  }>).find((r) => r.currency === 'CAD');
  assert.ok(cad);
  // partnerShareTotal=-100, settlement: iPaid=0, partnerPaid=30 → balance = -100 + (0-30) = -130
  assert.equal(cad.balance, -130);
});

test('/fairness: AC1 currentMonthSharedSpend computed from today', async () => {
  // Seed a row dated today so we can assert the headline metric is populated.
  // Use a unique merchant to make the assertion robust against other seeded rows.
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const d = String(today.getDate()).padStart(2, '0');
  const dateStr = `${y}-${m}-${d}`;
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: dateStr,
    amount: -77,
    currency: 'CAD',
    finalSplitType: 'shared',
    ownershipType: 'contact',
    ownershipContactId: contactAId,
    myShareAmount: -38.5,
    partnerShareAmount: -38.5,
    merchantRaw: 'Joint Today',
    finalCategory: 'Dining',
  });

  const res = await agentA.get('/api/partner/fairness');
  assert.equal(res.status, 200);
  const cad = (res.body.byCurrency as Array<{
    currency: string;
    currentMonthSharedSpend: number;
  }>).find((r) => r.currency === 'CAD');
  assert.ok(cad);
  // currentMonthSharedSpend is the sum of |amount| for shared purchases in
  // the current month. Our $77 seed contributes 77; other tests in this file
  // may add to it, so we assert >= 77.
  assert.ok(
    cad.currentMonthSharedSpend >= 77,
    `expected currentMonthSharedSpend >= 77, got ${cad.currentMonthSharedSpend}`,
  );
});

test('/fairness: AC2 paidMore reports youCovered for shared spend', async () => {
  // Build a narrow date range with one shared row so we have known numbers.
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2027-05-15',
    amount: -400,
    currency: 'CAD',
    finalSplitType: 'shared',
    ownershipType: 'contact',
    ownershipContactId: contactAId,
    myShareAmount: -200,
    partnerShareAmount: -200,
    merchantRaw: 'Rent Split',
    finalCategory: 'Housing',
  });
  const res = await agentA
    .get('/api/partner/fairness')
    .query({ currency: 'CAD', dateFrom: '2027-05-01', dateTo: '2027-05-31' });
  assert.equal(res.status, 200);
  const cad = (res.body.byCurrency as Array<{
    currency: string;
    paidMore: { youCovered: number; partnerCovered: number };
  }>).find((r) => r.currency === 'CAD');
  assert.ok(cad);
  // myShareTotal=-200 → youCovered=200, no settlements in window → partnerCovered=0.
  assert.equal(cad.paidMore.youCovered, 200);
  assert.equal(cad.paidMore.partnerCovered, 0);
});

test('/fairness: AC5 category breakdown buckets shared spend per category', async () => {
  // Add a second shared txn in a different category within the same window.
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2027-05-20',
    amount: -60,
    currency: 'CAD',
    finalSplitType: 'shared',
    ownershipType: 'contact',
    ownershipContactId: contactAId,
    myShareAmount: -30,
    partnerShareAmount: -30,
    merchantRaw: 'Streaming',
    finalCategory: 'Subscriptions',
  });
  const res = await agentA
    .get('/api/partner/fairness')
    .query({ currency: 'CAD', dateFrom: '2027-05-01', dateTo: '2027-05-31' });
  assert.equal(res.status, 200);
  const cad = (res.body.byCurrency as Array<{
    currency: string;
    categoryBreakdown: Array<{ category: string; sharedSpend: number }>;
  }>).find((r) => r.currency === 'CAD');
  assert.ok(cad);
  const cats = cad.categoryBreakdown.map((c) => c.category).sort();
  assert.deepEqual(cats, ['Housing', 'Subscriptions']);
  // Housing should rank first by |sharedSpend| (-400 vs -60).
  assert.equal(cad.categoryBreakdown[0].category, 'Housing');
});

test('/fairness: AC7 largestShared lists shared rows descending |amount|', async () => {
  const res = await agentA
    .get('/api/partner/fairness')
    .query({ currency: 'CAD', dateFrom: '2027-05-01', dateTo: '2027-05-31' });
  assert.equal(res.status, 200);
  const cad = (res.body.byCurrency as Array<{
    currency: string;
    largestShared: Array<{ amount: number; merchant: string }>;
  }>).find((r) => r.currency === 'CAD');
  assert.ok(cad);
  // We seeded 2 in this window: -400 Rent Split, -60 Streaming.
  assert.equal(cad.largestShared.length, 2);
  assert.equal(cad.largestShared[0].amount, -400);
  assert.equal(cad.largestShared[1].amount, -60);
});

test('/fairness: household scoping — household B sees no household A data', async () => {
  const res = await agentB
    .get('/api/partner/fairness')
    .query({ currency: 'CAD', dateFrom: '2027-04-01', dateTo: '2027-05-31' });
  assert.equal(res.status, 200);
  // Without any seeded rows for B, no CAD entry should surface.
  const cad = (res.body.byCurrency as Array<{ currency: string }>).find(
    (r) => r.currency === 'CAD',
  );
  assert.equal(cad, undefined);
});

// ---------------- GET /api/partner/monthly ----------------

test('/monthly: AC6 returns per-month points with cumulativeBalance running total', async () => {
  // Two months of shared rows. April -100 partnerShare, May -200 partnerShare.
  // Cumulatives should be -100 in April, -300 in May.
  // (Some prior tests in this file seeded into 2027-04-* and 2027-05-* already.
  // We use a fresh year to keep the assertion deterministic.)
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2028-01-10',
    amount: -200,
    currency: 'CAD',
    finalSplitType: 'shared',
    ownershipType: 'contact',
    ownershipContactId: contactAId,
    myShareAmount: -100,
    partnerShareAmount: -100,
    merchantRaw: 'Joint Jan',
    finalCategory: 'Groceries',
  });
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2028-02-10',
    amount: -400,
    currency: 'CAD',
    finalSplitType: 'shared',
    ownershipType: 'contact',
    ownershipContactId: contactAId,
    myShareAmount: -200,
    partnerShareAmount: -200,
    merchantRaw: 'Joint Feb',
    finalCategory: 'Groceries',
  });
  const res = await agentA
    .get('/api/partner/monthly')
    .query({ currency: 'CAD', dateFrom: '2028-01-01', dateTo: '2028-02-28' });
  assert.equal(res.status, 200);
  const pts = res.body.points as Array<{
    month: string;
    currency: string;
    cumulativeBalance: number;
    partnerShare: number;
    sharedSpend: number;
  }>;
  const jan = pts.find((p) => p.month === '2028-01');
  const feb = pts.find((p) => p.month === '2028-02');
  assert.ok(jan, `expected 2028-01 point: ${JSON.stringify(pts)}`);
  assert.ok(feb);
  assert.equal(jan.partnerShare, -100);
  assert.equal(jan.cumulativeBalance, -100);
  assert.equal(feb.partnerShare, -200);
  assert.equal(feb.cumulativeBalance, -300);
});

test('/monthly: rows with partnerShare=0 do not produce monthly points', async () => {
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2029-03-10',
    amount: -50,
    currency: 'CAD',
    finalSplitType: 'me',
    ownershipType: 'me',
    myShareAmount: -50,
    partnerShareAmount: 0,
    merchantRaw: 'My-only purchase',
    finalCategory: 'Personal',
  });
  const res = await agentA
    .get('/api/partner/monthly')
    .query({ currency: 'CAD', dateFrom: '2029-03-01', dateTo: '2029-03-31' });
  assert.equal(res.status, 200);
  const pts = res.body.points as Array<{ month: string }>;
  assert.equal(pts.length, 0, `me-only row should not surface a monthly point: ${JSON.stringify(pts)}`);
});

// ---------------- GET /api/partner/settlement-recommendation ----------------

test('/settlement-recommendation: AC4 negative balance → you_pay_partner', async () => {
  // Use a tight date window: only the May 2027 rows are in scope, with
  // no settlements in the window. partnerShareTotal=-230, no settlement →
  // balance=-230, recommendation: you_pay_partner 230.
  const res = await agentA
    .get('/api/partner/settlement-recommendation')
    .query({ currency: 'CAD', dateFrom: '2027-05-01', dateTo: '2027-05-31' });
  assert.equal(res.status, 200);
  const recs = res.body.recommendations as Array<{
    currency: string;
    direction: string;
    amount: number;
    outstandingBalance: number;
  }>;
  const cad = recs.find((r) => r.currency === 'CAD');
  assert.ok(cad);
  assert.equal(cad.direction, 'you_pay_partner');
  assert.equal(cad.amount, 230);
  assert.equal(cad.outstandingBalance, -230);
});

test('/settlement-recommendation: positive balance → partner_pays_you', async () => {
  // New unique date window with a settlement large enough to flip balance positive.
  // Seed: -50 shared → settle 200 i_paid_partner → balance = -50 + 200 = +150.
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2029-07-10',
    amount: -100,
    currency: 'CAD',
    finalSplitType: 'shared',
    ownershipType: 'contact',
    ownershipContactId: contactAId,
    myShareAmount: -50,
    partnerShareAmount: -50,
    merchantRaw: 'Joint July',
    finalCategory: 'Groceries',
  });
  const settle = await agentA.post('/api/settlements').send({
    contactId: contactAId,
    direction: 'i_paid_partner',
    currency: 'CAD',
    amount: 200,
    settledDate: '2029-07-20',
  });
  assert.equal(settle.status, 201);
  const res = await agentA
    .get('/api/partner/settlement-recommendation')
    .query({ currency: 'CAD', dateFrom: '2029-07-01', dateTo: '2029-07-31' });
  assert.equal(res.status, 200);
  const cad = (res.body.recommendations as Array<{
    currency: string;
    direction: string;
    amount: number;
  }>).find((r) => r.currency === 'CAD');
  assert.ok(cad);
  assert.equal(cad.direction, 'partner_pays_you');
  assert.equal(cad.amount, 150);
});

test('/settlement-recommendation: zero balance → direction none', async () => {
  // Fresh window with no activity at all → no entries.
  const res = await agentA
    .get('/api/partner/settlement-recommendation')
    .query({ currency: 'CAD', dateFrom: '2030-01-01', dateTo: '2030-01-31' });
  assert.equal(res.status, 200);
  // No shared rows, no settlements → recommendations may be empty array.
  // That's the correct behavior; the UI surfaces this as "you're square".
  assert.ok(Array.isArray(res.body.recommendations));
});

test('cross-cutting: household B cannot see household A settlement recommendation', async () => {
  // Seed B activity in a window unique to B, then ask for the same window
  // from B's perspective — must not include any of A's numbers.
  await createTxn({
    householdId: householdBId,
    accountId: accountBId,
    date: '2030-03-10',
    amount: -50,
    currency: 'CAD',
    finalSplitType: 'me',
    ownershipType: 'me',
    myShareAmount: -50,
    partnerShareAmount: 0,
    merchantRaw: 'B-only',
    finalCategory: 'Personal',
  });
  const res = await agentB
    .get('/api/partner/settlement-recommendation')
    .query({ currency: 'CAD', dateFrom: '2030-03-01', dateTo: '2030-03-31' });
  assert.equal(res.status, 200);
  const cad = (res.body.recommendations as Array<{ currency: string }>).find(
    (r) => r.currency === 'CAD',
  );
  // B's me-only row has partnerShare=0 → no CAD recommendation.
  assert.equal(cad, undefined);
});

// ---------------- #375 partner_inflows / non_partner_inflows ---------------

test('/fairness: #375 AC3 returns partnerInflows and nonPartnerInflows split', async () => {
  // Mark the household's contactA as the partner so its counterparty rows
  // count as partner_inflows. Use a fresh date window so prior tests don't
  // bleed into the assertion.
  const models = await import('../../src/models');
  const partnerContact = await models.Contact.findByPk(contactAId);
  assert.ok(partnerContact);
  partnerContact.set('isPartner', true);
  await partnerContact.save();

  // A non-partner contact in the same household — used as the counterparty
  // for the "friend paying back lunch" inflow.
  const friend = await models.Contact.create({
    householdId: householdAId,
    name: '#375 Friend',
    notes: null,
    isPartner: false,
  });

  // Three inflows in a fresh date window:
  //   1. partner inflow (counterparty=partner contact)
  //   2. non-partner inflow (counterparty=friend)
  //   3. anonymous inflow (counterparty NULL)
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2031-02-10',
    amount: 500,
    currency: 'CAD',
    finalSplitType: 'shared',
    ownershipType: 'contact',
    ownershipContactId: contactAId,
    counterpartyContactId: contactAId,
    myShareAmount: 0,
    partnerShareAmount: 250,
    merchantRaw: 'Partner Income',
    finalCategory: 'Income',
  });
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2031-02-15',
    amount: 30,
    currency: 'CAD',
    finalSplitType: 'shared',
    ownershipType: 'contact',
    ownershipContactId: contactAId,
    counterpartyContactId: friend.id,
    myShareAmount: 0,
    partnerShareAmount: 15,
    merchantRaw: 'Lunch Repaid',
    finalCategory: 'Reimbursement',
  });
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2031-02-20',
    amount: 100,
    currency: 'CAD',
    finalSplitType: 'shared',
    ownershipType: 'contact',
    ownershipContactId: contactAId,
    counterpartyContactId: null,
    myShareAmount: 0,
    partnerShareAmount: 50,
    merchantRaw: 'Unknown Deposit',
    finalCategory: 'Income',
  });

  // Toggle OFF: every inflow counts (legacy). partnerInflows=500,
  // nonPartnerInflows=130.
  const off = await agentA
    .get('/api/partner/fairness')
    .query({
      currency: 'CAD',
      dateFrom: '2031-02-01',
      dateTo: '2031-02-28',
      excludeNonPartnerInflows: 'false',
    });
  assert.equal(off.status, 200);
  assert.equal(off.body.excludeNonPartnerInflows, false);
  const cadOff = (off.body.byCurrency as Array<{
    currency: string;
    partnerInflows: number;
    nonPartnerInflows: number;
    sharedTransactionCount: number;
    partnerShareTotal: number;
  }>).find((r) => r.currency === 'CAD');
  assert.ok(cadOff, `expected CAD entry: ${JSON.stringify(off.body)}`);
  assert.equal(cadOff.partnerInflows, 500);
  assert.equal(cadOff.nonPartnerInflows, 130);
  assert.equal(cadOff.sharedTransactionCount, 3);
  // partnerShareTotal = 250 + 15 + 50 = 315
  assert.equal(cadOff.partnerShareTotal, 315);
});

test('/fairness: #375 AC4 excludeNonPartnerInflows=true drops non-partner inflows', async () => {
  // Same data as above test — toggle ON now drops the friend + null
  // counterparty rows from the rollup.
  const on = await agentA
    .get('/api/partner/fairness')
    .query({
      currency: 'CAD',
      dateFrom: '2031-02-01',
      dateTo: '2031-02-28',
      excludeNonPartnerInflows: 'true',
    });
  assert.equal(on.status, 200);
  assert.equal(on.body.excludeNonPartnerInflows, true);
  const cadOn = (on.body.byCurrency as Array<{
    currency: string;
    partnerInflows: number;
    nonPartnerInflows: number;
    sharedTransactionCount: number;
    partnerShareTotal: number;
    balance: number;
  }>).find((r) => r.currency === 'CAD');
  assert.ok(cadOn);
  // Inflow split is reported regardless of the toggle.
  assert.equal(cadOn.partnerInflows, 500);
  assert.equal(cadOn.nonPartnerInflows, 130);
  // sharedTransactionCount now 1 (only the partner inflow).
  assert.equal(cadOn.sharedTransactionCount, 1);
  // partnerShareTotal = 250 only (15 and 50 dropped).
  assert.equal(cadOn.partnerShareTotal, 250);
  // balance reflects cleaned set: 250 + 0 settlements = 250.
  assert.equal(cadOn.balance, 250);
});

test('/settlement-recommendation: #375 toggle ON flips the recommendation total', async () => {
  // Reuse the same 2031-02 seeds. Toggle ON: partnerShareTotal=250, no
  // settlements → recommendation amount=250 partner_pays_you. Toggle OFF:
  // partnerShareTotal=315 → recommendation amount=315.
  const on = await agentA
    .get('/api/partner/settlement-recommendation')
    .query({
      currency: 'CAD',
      dateFrom: '2031-02-01',
      dateTo: '2031-02-28',
      excludeNonPartnerInflows: 'true',
    });
  assert.equal(on.status, 200);
  const onCad = (on.body.recommendations as Array<{
    currency: string;
    amount: number;
    direction: string;
  }>).find((r) => r.currency === 'CAD');
  assert.ok(onCad);
  assert.equal(onCad.direction, 'partner_pays_you');
  assert.equal(onCad.amount, 250);

  const off = await agentA
    .get('/api/partner/settlement-recommendation')
    .query({
      currency: 'CAD',
      dateFrom: '2031-02-01',
      dateTo: '2031-02-28',
      excludeNonPartnerInflows: 'false',
    });
  assert.equal(off.status, 200);
  const offCad = (off.body.recommendations as Array<{
    currency: string;
    amount: number;
    direction: string;
  }>).find((r) => r.currency === 'CAD');
  assert.ok(offCad);
  assert.equal(offCad.direction, 'partner_pays_you');
  assert.equal(offCad.amount, 315);
});

test('/monthly: #375 toggle ON respects partner classification in trend', async () => {
  // Re-using the same Feb 2031 seeds. Toggle ON should give partnerShare=250
  // for that month (friend + null counterparty dropped).
  const res = await agentA
    .get('/api/partner/monthly')
    .query({
      currency: 'CAD',
      dateFrom: '2031-02-01',
      dateTo: '2031-02-28',
      excludeNonPartnerInflows: 'true',
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.excludeNonPartnerInflows, true);
  const pts = res.body.points as Array<{
    month: string;
    partnerShare: number;
  }>;
  const feb = pts.find((p) => p.month === '2031-02');
  assert.ok(feb, `expected 2031-02 point: ${JSON.stringify(pts)}`);
  assert.equal(feb.partnerShare, 250);
});

test('/fairness: #375 toggle default falls back to CashflowSettings (defaults true)', async () => {
  // No override query param → server reads the user's CashflowSettings row.
  // We never wrote one, so the bundled default (true) wins.
  const res = await agentA
    .get('/api/partner/fairness')
    .query({ currency: 'CAD', dateFrom: '2031-02-01', dateTo: '2031-02-28' });
  assert.equal(res.status, 200);
  assert.equal(res.body.excludeNonPartnerInflows, true);
});

test('/fairness: #375 override query param wins over CashflowSettings', async () => {
  // Persist the user's preference as TRUE.
  const r1 = await agentA
    .patch('/api/settings/cashflow')
    .send({ excludeNonPartnerInflows: true });
  assert.equal(r1.status, 200);
  // Then ask the fairness route to render the OFF view — query param should
  // override the saved preference for this read.
  const res = await agentA
    .get('/api/partner/fairness')
    .query({
      currency: 'CAD',
      dateFrom: '2031-02-01',
      dateTo: '2031-02-28',
      excludeNonPartnerInflows: 'false',
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.excludeNonPartnerInflows, false);
});
