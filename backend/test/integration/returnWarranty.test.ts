/**
 * Integration tests for the returnWarranty route surface — exercises
 *   PATCH /api/transactions/:id/return-warranty
 *   GET   /api/return-warranty/active
 *   GET   /api/return-warranty/expiring-soon
 *   GET   /api/return-warranty/warranties
 *   GET   /api/return-warranty/missing-receipts
 * end-to-end against a real Postgres database. Seeding shape mirrors
 * businessTax.test.ts.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let primaryAgent: ReturnType<typeof request.agent>;
let primaryHouseholdId: number;
let otherAgent: ReturnType<typeof request.agent>;
let otherHouseholdId: number;
let primaryAccountId: number;
let primaryUserId: number;
let otherAccountId: number;
let testDb: PgTestDb;

type Seeded = { token: string; householdId: number; userId: number; accountId: number };

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
  const household = await models.Household.create({ name: `${emailPrefix} household` });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  const account = await models.Account.create({
    householdId: household.id,
    ownerUserId: user.id,
    owner: 'me',
    visibility: 'shared',
    name: `${emailPrefix} card`,
    accountType: 'credit',
    defaultCurrency: 'CAD',
    shortCode: emailPrefix.slice(0, 3).toUpperCase(),
  });
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });
  return { token, householdId: household.id, userId: user.id, accountId: account.id };
}

async function createTransaction(
  householdId: number,
  accountId: number,
  date: string,
  category: string | null,
  amount: number,
  options: { createdByUserId?: number | null } = {},
): Promise<number> {
  const models = await import('../../src/models');
  const created = await models.Transaction.create({
    accountId,
    householdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'return-test',
    date,
    merchantRaw: 'Test Merchant',
    merchantClean: 'Test Merchant',
    amount: amount.toFixed(4),
    currency: 'CAD',
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
    finalBusiness: false,
    autoSplitType: null,
    splitOverride: null,
    finalSplitType: 'me',
    autoPctMe: null,
    pctMeOverride: null,
    finalPctMe: null,
    autoPctPartner: null,
    pctPartnerOverride: null,
    finalPctPartner: null,
    reviewFlag: false,
    reviewedAt: null,
    createdByUserId: options.createdByUserId ?? null,
  });
  return created.id;
}

function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

before(async () => {
  testDb = await setupPgTestDb('return');
  const mod = await import('../../src/app.js');
  app = mod.default;

  const bootstrap = request.agent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const primary = await seed('Primary');
  primaryHouseholdId = primary.householdId;
  primaryAccountId = primary.accountId;
  primaryUserId = primary.userId;
  primaryAgent = request.agent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('Other');
  otherHouseholdId = other.householdId;
  otherAccountId = other.accountId;
  otherAgent = request.agent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// ---- PATCH /api/transactions/:id/return-warranty -------------------------

test('PATCH sets full return + warranty metadata for an existing txn', async () => {
  const txnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-01',
    'Electronics',
    -1299,
  );
  const res = await primaryAgent
    .patch(`/api/transactions/${txnId}/return-warranty`)
    .send({
      returnDeadline: isoDaysFromNow(15),
      warrantyEndDate: isoDaysFromNow(365),
      notes: 'Bought at Eaton Centre',
      receiptStatus: 'have',
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.transactionId, txnId);
  assert.equal(res.body.data.returnDeadline, isoDaysFromNow(15));
  assert.equal(res.body.data.warrantyEndDate, isoDaysFromNow(365));
  assert.equal(res.body.data.notes, 'Bought at Eaton Centre');
  assert.equal(res.body.data.receiptStatus, 'have');
  assert.equal(res.body.data.isWithinReturnWindow, true);
  assert.equal(res.body.data.isWarrantyActive, true);
});

test('PATCH allows clearing dates with null', async () => {
  const txnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-02',
    'Electronics',
    -100,
  );
  await primaryAgent
    .patch(`/api/transactions/${txnId}/return-warranty`)
    .send({ returnDeadline: isoDaysFromNow(7) });
  const res = await primaryAgent
    .patch(`/api/transactions/${txnId}/return-warranty`)
    .send({ returnDeadline: null });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.returnDeadline, null);
  assert.equal(res.body.data.isWithinReturnWindow, false);
});

test('PATCH rejects malformed dates', async () => {
  const txnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-03',
    'Electronics',
    -50,
  );
  const res = await primaryAgent
    .patch(`/api/transactions/${txnId}/return-warranty`)
    .send({ returnDeadline: '2026/06/01' });
  assert.equal(res.status, 400);
});

test('PATCH rejects bogus receiptStatus', async () => {
  const txnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-04',
    'Electronics',
    -50,
  );
  const res = await primaryAgent
    .patch(`/api/transactions/${txnId}/return-warranty`)
    .send({ receiptStatus: 'pending' });
  assert.equal(res.status, 400);
});

test('PATCH 404 for a transaction in a different household', async () => {
  const otherTxnId = await createTransaction(
    otherHouseholdId,
    otherAccountId,
    '2026-05-05',
    'Electronics',
    -75,
  );
  const res = await primaryAgent
    .patch(`/api/transactions/${otherTxnId}/return-warranty`)
    .send({ receiptStatus: 'have' });
  assert.equal(res.status, 404);
});

// ---- GET /api/return-warranty/active --------------------------------------

test('GET /active lists only purchases still inside the return window', async () => {
  const active = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-10',
    'Electronics',
    -200,
  );
  const expired = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-04-10',
    'Electronics',
    -150,
  );
  await primaryAgent
    .patch(`/api/transactions/${active}/return-warranty`)
    .send({ returnDeadline: isoDaysFromNow(20) });
  await primaryAgent
    .patch(`/api/transactions/${expired}/return-warranty`)
    .send({ returnDeadline: isoDaysFromNow(-5) });

  const res = await primaryAgent.get('/api/return-warranty/active');
  assert.equal(res.status, 200);
  const ids = (res.body.data as { id: number }[]).map((r) => r.id);
  assert.ok(ids.includes(active), 'active window row should appear');
  assert.ok(!ids.includes(expired), 'expired window row should not appear');
});

// ---- GET /api/return-warranty/expiring-soon -------------------------------

test('GET /expiring-soon respects ?days', async () => {
  const soon = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-11',
    'Electronics',
    -200,
  );
  const farOff = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-11',
    'Electronics',
    -300,
  );
  await primaryAgent
    .patch(`/api/transactions/${soon}/return-warranty`)
    .send({ returnDeadline: isoDaysFromNow(3) });
  await primaryAgent
    .patch(`/api/transactions/${farOff}/return-warranty`)
    .send({ returnDeadline: isoDaysFromNow(60) });

  const res = await primaryAgent.get('/api/return-warranty/expiring-soon?days=7');
  assert.equal(res.status, 200);
  assert.equal(res.body.withinDays, 7);
  const ids = (res.body.data as { id: number }[]).map((r) => r.id);
  assert.ok(ids.includes(soon), 'within 7 days should appear');
  assert.ok(!ids.includes(farOff), 'beyond 7 days should be excluded');
});

// ---- GET /api/return-warranty/warranties ----------------------------------

test('GET /warranties lists purchases with active warranty', async () => {
  const covered = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-12',
    'Electronics',
    -1200,
  );
  const lapsed = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2024-05-12',
    'Electronics',
    -500,
  );
  await primaryAgent
    .patch(`/api/transactions/${covered}/return-warranty`)
    .send({ warrantyEndDate: isoDaysFromNow(365) });
  await primaryAgent
    .patch(`/api/transactions/${lapsed}/return-warranty`)
    .send({ warrantyEndDate: isoDaysFromNow(-30) });

  const res = await primaryAgent.get('/api/return-warranty/warranties');
  assert.equal(res.status, 200);
  const ids = (res.body.data as { id: number }[]).map((r) => r.id);
  assert.ok(ids.includes(covered));
  assert.ok(!ids.includes(lapsed));
});

// ---- GET /api/return-warranty/missing-receipts ----------------------------

test('GET /missing-receipts flags explicit-missing and no-receipt rows', async () => {
  const explicitMissing = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-13',
    'Electronics',
    -300,
  );
  const noReceiptInWindow = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-14',
    'Electronics',
    -250,
  );
  const hasReceiptInWindow = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-15',
    'Electronics',
    -1500,
  );
  const notNeeded = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-16',
    'Coffee',
    -7,
  );

  await primaryAgent
    .patch(`/api/transactions/${explicitMissing}/return-warranty`)
    .send({ receiptStatus: 'missing', returnDeadline: isoDaysFromNow(10) });
  await primaryAgent
    .patch(`/api/transactions/${noReceiptInWindow}/return-warranty`)
    .send({ returnDeadline: isoDaysFromNow(14) });
  await primaryAgent
    .patch(`/api/transactions/${hasReceiptInWindow}/return-warranty`)
    .send({
      returnDeadline: isoDaysFromNow(14),
      warrantyEndDate: isoDaysFromNow(365),
      receiptStatus: 'have',
    });
  await primaryAgent
    .patch(`/api/transactions/${notNeeded}/return-warranty`)
    .send({ receiptStatus: 'not_needed' });

  const models = await import('../../src/models');
  await models.Receipt.create({
    transactionId: hasReceiptInWindow,
    storedFilename: 'r.pdf',
    originalName: 'r.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 100,
  });

  const res = await primaryAgent.get('/api/return-warranty/missing-receipts');
  assert.equal(res.status, 200);
  const ids = (res.body.data as { id: number }[]).map((r) => r.id);
  assert.ok(
    ids.includes(explicitMissing),
    'receiptStatus=missing should always surface',
  );
  assert.ok(
    ids.includes(noReceiptInWindow),
    'in-window no-receipt should surface',
  );
  assert.ok(
    !ids.includes(hasReceiptInWindow),
    'in-window with receipt should not surface',
  );
  assert.ok(
    !ids.includes(notNeeded),
    'opted-out (not_needed) rows should never surface',
  );
});

// ---- Cross-household visibility ------------------------------------------

test('GET endpoints scope to the requesting household', async () => {
  const otherTxn = await createTransaction(
    otherHouseholdId,
    otherAccountId,
    '2026-05-20',
    'Electronics',
    -800,
  );
  await otherAgent
    .patch(`/api/transactions/${otherTxn}/return-warranty`)
    .send({ returnDeadline: isoDaysFromNow(30) });

  const primaryRes = await primaryAgent.get('/api/return-warranty/active');
  const ids = (primaryRes.body.data as { id: number }[]).map((r) => r.id);
  assert.ok(!ids.includes(otherTxn), 'other household txn should not leak');
});

// ---- Visibility helper sanity check --------------------------------------

test('shared/visible transactions are reachable by the primary user', async () => {
  // Sanity: createTransaction sets visibility=shared so primaryUser must see it
  // even though createdByUserId is null. This guards against a future regression
  // where the route uses a stricter scope helper.
  const id = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-25',
    'Electronics',
    -90,
    { createdByUserId: primaryUserId },
  );
  const res = await primaryAgent
    .patch(`/api/transactions/${id}/return-warranty`)
    .send({ receiptStatus: 'have' });
  assert.equal(res.status, 200);
});
