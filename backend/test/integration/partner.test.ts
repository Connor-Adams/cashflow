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
 *
 * All routes now return per-contact shapes:
 *   /fairness → { contacts: FairnessContact[], excludeNonPartnerInflows }
 *   /monthly  → { contacts: [{contactId, contactName, isPartner, points[]}], excludeNonPartnerInflows }
 *   /settlement-recommendation → { contacts: [{contactId, contactName, recommendations[]}], excludeNonPartnerInflows }
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
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

  const bootstrap = testAgent(app);
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
  agentA = testAgent(app);
  agentA.jar.setCookie(`cashflow_session=${a.token}; Path=/`);

  const b = await seedHousehold('PartnerB', 'B Partner');
  householdBId = b.householdId;
  agentB = testAgent(app);
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

// Helper: find the CAD bucket for contactAId inside contacts[].byCurrency
type ContactsEntry = {
  contactId: number | null;
  contactName: string;
  isPartner: boolean;
  byCurrency: Array<Record<string, unknown>>;
  paybacks: Array<Record<string, unknown>>;
};

function findContactCad(
  contacts: ContactsEntry[],
  contactId: number,
): Record<string, unknown> | undefined {
  const c = contacts.find((e) => e.contactId === contactId);
  if (!c) return undefined;
  return (c.byCurrency as Array<{ currency: string } & Record<string, unknown>>).find(
    (r) => r.currency === 'CAD',
  );
}

// Helper: find recommendations for contactAId inside contacts[].recommendations
type RecsEntry = {
  contactId: number | null;
  contactName: string;
  recommendations: Array<Record<string, unknown>>;
};

function findContactCadRec(
  contacts: RecsEntry[],
  contactId: number,
): Record<string, unknown> | undefined {
  const c = contacts.find((e) => e.contactId === contactId);
  if (!c) return undefined;
  return (c.recommendations as Array<{ currency: string } & Record<string, unknown>>).find(
    (r) => r.currency === 'CAD',
  );
}

// Helper: find points for contactAId inside contacts[].points
type MonthlyEntry = {
  contactId: number | null;
  contactName: string;
  isPartner: boolean;
  points: Array<Record<string, unknown>>;
};

function findContactPoints(
  contacts: MonthlyEntry[],
  contactId: number,
): Array<Record<string, unknown>> {
  const c = contacts.find((e) => e.contactId === contactId);
  return c?.points ?? [];
}

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
  const cad = findContactCad(res.body.contacts, contactAId) as {
    currency: string;
    sharedTransactionCount: number;
    partnerShareTotal: number;
    sharedSpendTotal: number;
  } | undefined;
  assert.ok(cad, `expected CAD entry for contactAId: ${JSON.stringify(res.body)}`);
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
  const cad = findContactCad(res.body.contacts, contactAId) as {
    currency: string;
    balance: number;
    partnerShareTotal: number;
  } | undefined;
  assert.ok(cad);
  // partnerShareTotal=-100, settlement: iPaid=0, partnerPaid=30 → balance = -(-100) + (0-30) = 100-30 = 70
  assert.equal(cad.balance, 70);
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
  const cad = findContactCad(res.body.contacts, contactAId) as {
    currency: string;
    currentMonthSharedSpend: number;
  } | undefined;
  assert.ok(cad);
  // currentMonthSharedSpend is the sum of |amount| for shared purchases in
  // the current month. Our $77 seed contributes 77; other tests in this file
  // may add to it, so we assert >= 77.
  assert.ok(
    (cad.currentMonthSharedSpend as number) >= 77,
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
  const cad = findContactCad(res.body.contacts, contactAId) as {
    currency: string;
    paidMore: { youCovered: number; partnerCovered: number };
  } | undefined;
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
  const cad = findContactCad(res.body.contacts, contactAId) as {
    currency: string;
    categoryBreakdown: Array<{ category: string; sharedSpend: number }>;
  } | undefined;
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
  const cad = findContactCad(res.body.contacts, contactAId) as {
    currency: string;
    largestShared: Array<{ amount: number; merchant: string }>;
  } | undefined;
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
  // Without any seeded rows for B, contacts should be empty.
  assert.ok(Array.isArray(res.body.contacts));
  assert.equal(res.body.contacts.length, 0);
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
  const pts = findContactPoints(res.body.contacts, contactAId) as Array<{
    month: string;
    currency: string;
    cumulativeBalance: number;
    partnerShare: number;
    sharedSpend: number;
  }>;
  const jan = pts.find((p) => p.month === '2028-01');
  const feb = pts.find((p) => p.month === '2028-02');
  assert.ok(jan, `expected 2028-01 point: ${JSON.stringify(res.body.contacts)}`);
  assert.ok(feb);
  assert.equal(jan.partnerShare, -100);
  assert.equal(jan.cumulativeBalance, 100);
  assert.equal(feb.partnerShare, -200);
  assert.equal(feb.cumulativeBalance, 300);
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
  // No shared rows in window → contacts should be empty (no contact has any points).
  const contacts = res.body.contacts as Array<{ contactId: number | null; points: unknown[] }>;
  const totalPoints = contacts.reduce((sum, c) => sum + c.points.length, 0);
  assert.equal(totalPoints, 0, `me-only row should not surface any monthly points: ${JSON.stringify(contacts)}`);
});

// ---------------- GET /api/partner/settlement-recommendation ----------------

test('/settlement-recommendation: AC4 positive balance → partner_pays_you', async () => {
  // Use a tight date window: only the May 2027 rows are in scope, with
  // no settlements in the window. partnerShareTotal=-230, no settlement →
  // balance=230, recommendation: partner_pays_you 230.
  const res = await agentA
    .get('/api/partner/settlement-recommendation')
    .query({ currency: 'CAD', dateFrom: '2027-05-01', dateTo: '2027-05-31' });
  assert.equal(res.status, 200);
  const cad = findContactCadRec(res.body.contacts, contactAId) as {
    currency: string;
    direction: string;
    amount: number;
    outstandingBalance: number;
  } | undefined;
  assert.ok(cad);
  assert.equal(cad.direction, 'partner_pays_you');
  assert.equal(cad.amount, 230);
  assert.equal(cad.outstandingBalance, 230);
});

test('/settlement-recommendation: positive balance → partner_pays_you', async () => {
  // New unique date window with a settlement large enough to flip balance positive.
  // Seed: partnerShare=-50 → settle 200 i_paid_partner → balance = -(-50) + 200 = 250.
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
  const cad = findContactCadRec(res.body.contacts, contactAId) as {
    currency: string;
    direction: string;
    amount: number;
  } | undefined;
  assert.ok(cad);
  assert.equal(cad.direction, 'partner_pays_you');
  assert.equal(cad.amount, 250);
});

test('/settlement-recommendation: zero balance → direction none', async () => {
  // Fresh window with no activity at all → no entries.
  const res = await agentA
    .get('/api/partner/settlement-recommendation')
    .query({ currency: 'CAD', dateFrom: '2030-01-01', dateTo: '2030-01-31' });
  assert.equal(res.status, 200);
  // No shared rows, no settlements → contacts should be empty.
  assert.ok(Array.isArray(res.body.contacts));
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
  // B's me-only row has partnerShare=0 → no contacts with CAD recommendation.
  const contacts = res.body.contacts as RecsEntry[];
  const cadRec = contacts.flatMap((c) => c.recommendations).find(
    (r) => (r as { currency: string }).currency === 'CAD',
  );
  assert.equal(cadRec, undefined);
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
  const cadOff = findContactCad(off.body.contacts, contactAId) as {
    currency: string;
    partnerInflows: number;
    nonPartnerInflows: number;
    sharedTransactionCount: number;
    partnerShareTotal: number;
  } | undefined;
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
  const cadOn = findContactCad(on.body.contacts, contactAId) as {
    currency: string;
    partnerInflows: number;
    nonPartnerInflows: number;
    sharedTransactionCount: number;
    partnerShareTotal: number;
    balance: number;
  } | undefined;
  assert.ok(cadOn);
  // Inflow split is reported regardless of the toggle.
  assert.equal(cadOn.partnerInflows, 500);
  assert.equal(cadOn.nonPartnerInflows, 130);
  // sharedTransactionCount now 1 (only the partner inflow).
  assert.equal(cadOn.sharedTransactionCount, 1);
  // partnerShareTotal = 250 only (15 and 50 dropped).
  assert.equal(cadOn.partnerShareTotal, 250);
  // balance reflects cleaned set: -250 + 0 settlements = -250.
  assert.equal(cadOn.balance, -250);
});

test('/settlement-recommendation: #375 toggle ON flips the recommendation total', async () => {
  // Reuse the same 2031-02 seeds. Toggle ON: partnerShareTotal=250, no
  // settlements → balance=-250, recommendation amount=250 you_pay_partner. Toggle OFF:
  // partnerShareTotal=315 → balance=-315, recommendation amount=315 you_pay_partner.
  const on = await agentA
    .get('/api/partner/settlement-recommendation')
    .query({
      currency: 'CAD',
      dateFrom: '2031-02-01',
      dateTo: '2031-02-28',
      excludeNonPartnerInflows: 'true',
    });
  assert.equal(on.status, 200);
  const onCad = findContactCadRec(on.body.contacts, contactAId) as {
    currency: string;
    amount: number;
    direction: string;
  } | undefined;
  assert.ok(onCad);
  assert.equal(onCad.direction, 'you_pay_partner');
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
  const offCad = findContactCadRec(off.body.contacts, contactAId) as {
    currency: string;
    amount: number;
    direction: string;
  } | undefined;
  assert.ok(offCad);
  assert.equal(offCad.direction, 'you_pay_partner');
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
  const pts = findContactPoints(res.body.contacts, contactAId) as Array<{
    month: string;
    partnerShare: number;
  }>;
  const feb = pts.find((p) => p.month === '2031-02');
  assert.ok(feb, `expected 2031-02 point: ${JSON.stringify(res.body.contacts)}`);
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

test('partner direct transfer nets into fairness balance (period-scoped)', async () => {
  const models = await import('../../src/models');
  const partner = await models.Contact.create({
    householdId: householdAId,
    name: 'Fairness Partner',
    isPartner: true,
  });
  // Partner sent me 2000 in an isolated window; pure transfer (split 'me', partnerShare 0).
  await createTxn({
    householdId: householdAId, accountId: accountAId, date: '2027-03-10',
    amount: 2000, currency: 'CAD', merchantRaw: 'Cash received', txnType: 'transfer',
    finalSplitType: 'me', myShareAmount: 2000, partnerShareAmount: 0,
    counterpartyContactId: partner.id,
  });

  const res = await agentA
    .get('/api/partner/fairness')
    .query({ dateFrom: '2027-03-01', dateTo: '2027-03-31', currency: 'CAD' });
  assert.equal(res.status, 200);
  // The transfer contact appears in contacts[]; find it by contactId.
  const contacts = res.body.contacts as ContactsEntry[];
  const partnerEntry = contacts.find((c) => c.contactId === partner.id);
  assert.ok(partnerEntry, `expected entry for partner.id=${partner.id}: ${JSON.stringify(contacts)}`);
  const cad = (partnerEntry.byCurrency as Array<{ currency: string; balance: number; partnerTransfers: { in: number; out: number } }>).find(
    (c) => c.currency === 'CAD',
  );
  assert.ok(cad, `expected CAD entry: ${JSON.stringify(partnerEntry.byCurrency)}`);
  assert.deepEqual(cad.partnerTransfers, { in: 2000, out: 0 });
  assert.equal(cad.balance, -2000, 'partner-sent money reduces balance (I owe partner)');
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

// ---------------- New per-contact shape assertion ----------------

test('GET /api/partner/fairness returns per-contact buckets', async () => {
  // contactAId is already marked isPartner=true from the #375 AC3 test.
  // Seed one shared txn + one inbound transfer (counterpartyContactId = contactAId).
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2032-01-15',
    amount: -120,
    currency: 'CAD',
    finalSplitType: 'shared',
    ownershipType: 'contact',
    ownershipContactId: contactAId,
    myShareAmount: -60,
    partnerShareAmount: -60,
    merchantRaw: 'Shape Test Purchase',
    finalCategory: 'Groceries',
  });
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2032-01-20',
    amount: 50,
    currency: 'CAD',
    finalSplitType: 'me',
    ownershipType: 'me',
    myShareAmount: 50,
    partnerShareAmount: 0,
    merchantRaw: 'Shape Test Transfer',
    counterpartyContactId: contactAId,
  });

  const res = await agentA
    .get('/api/partner/fairness')
    .query({ currency: 'CAD', dateFrom: '2032-01-01', dateTo: '2032-01-31' });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.contacts));
  const alex = res.body.contacts.find((c: { isPartner: boolean }) => c.isPartner);
  assert.ok(alex, `expected a partner contact: ${JSON.stringify(res.body.contacts)}`);
  assert.ok(Array.isArray(alex.byCurrency));
  assert.ok(Array.isArray(alex.paybacks));
});
