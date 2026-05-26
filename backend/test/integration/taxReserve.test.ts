/**
 * Integration tests for the tax-reserve route surface — exercises
 * /api/tax/reserve/settings (GET, PUT, DELETE) and /api/tax/reserve/summary
 * end-to-end against a real Postgres database. Same seeding shape as
 * businessTax.test.ts so the two test files coexist comfortably.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let primaryAgent: ReturnType<typeof request.agent>;
let primaryHouseholdId: number;
let primaryAccountId: number;
let otherAgent: ReturnType<typeof request.agent>;
let otherHouseholdId: number;
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

interface TxnOptions {
  business?: boolean;
  split?: string;
  currency?: string;
  hstGstAmount?: number | null;
  deductiblePercent?: number;
}

async function createTransaction(
  householdId: number,
  accountId: number,
  date: string,
  amount: number,
  options: TxnOptions = {},
): Promise<number> {
  const models = await import('../../src/models');
  const created = await models.Transaction.create({
    accountId,
    householdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'reserve-test',
    date,
    merchantRaw: 'Test',
    merchantClean: 'Test',
    amount: amount.toFixed(4),
    currency: options.currency ?? 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: null,
    autoBusiness: null,
    businessOverride: options.business ?? null,
    finalBusiness: options.business ?? false,
    autoSplitType: null,
    splitOverride: null,
    finalSplitType: options.split ?? 'me',
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
  if (options.hstGstAmount != null || options.deductiblePercent != null) {
    await models.TransactionTaxMetadata.create({
      transactionId: created.id,
      taxTagId: null,
      deductiblePercent:
        options.deductiblePercent != null
          ? options.deductiblePercent.toFixed(4)
          : options.business
            ? '1.0000'
            : '0.0000',
      hstGstAmount:
        options.hstGstAmount != null ? options.hstGstAmount.toFixed(4) : null,
      receiptRequired: Boolean(options.business),
      reviewedForTax: false,
    });
  }
  return created.id;
}

before(async () => {
  testDb = await setupPgTestDb('taxreserve');
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

// ---- GET /api/tax/reserve/settings -------------------------------------

test('GET /api/tax/reserve/settings: empty household returns empty list', async () => {
  const res = await primaryAgent.get('/api/tax/reserve/settings');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, []);
});

test('GET /api/tax/reserve/settings: synthesises a default row per observed currency', async () => {
  // Seed a business txn in CAD and one in USD; expect two synthesised
  // defaults (isDefault: true) since no explicit settings exist yet.
  await createTransaction(primaryHouseholdId, primaryAccountId, '2026-03-01', 1000, {
    business: true,
    currency: 'CAD',
  });
  await createTransaction(primaryHouseholdId, primaryAccountId, '2026-03-02', 500, {
    business: true,
    currency: 'USD',
  });
  const res = await primaryAgent.get('/api/tax/reserve/settings');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 2);
  const cad = res.body.data.find((r: { currency: string }) => r.currency === 'CAD');
  const usd = res.body.data.find((r: { currency: string }) => r.currency === 'USD');
  assert.equal(cad.isDefault, true);
  assert.equal(cad.reservePercent, '0.2500');
  assert.equal(usd.isDefault, true);
});

// ---- PUT /api/tax/reserve/settings/:currency ---------------------------

test('PUT /api/tax/reserve/settings/:currency: creates a row on first write', async () => {
  const res = await primaryAgent
    .put('/api/tax/reserve/settings/CAD')
    .send({ reservePercent: 0.3, note: 'ON sole prop' });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.currency, 'CAD');
  assert.equal(Number(res.body.data.reservePercent), 0.3);
  assert.equal(res.body.data.note, 'ON sole prop');
  assert.equal(res.body.data.isDefault, false);
});

test('PUT /api/tax/reserve/settings/:currency: updates an existing row', async () => {
  const res = await primaryAgent
    .put('/api/tax/reserve/settings/CAD')
    .send({ reservePercent: 0.35 });
  assert.equal(res.status, 200);
  assert.equal(Number(res.body.data.reservePercent), 0.35);
  // Note preserved on partial update.
  assert.equal(res.body.data.note, 'ON sole prop');
});

test('PUT /api/tax/reserve/settings/:currency: rejects percent out of range', async () => {
  const tooHigh = await primaryAgent
    .put('/api/tax/reserve/settings/CAD')
    .send({ reservePercent: 1.5 });
  assert.equal(tooHigh.status, 400);
  const tooLow = await primaryAgent
    .put('/api/tax/reserve/settings/CAD')
    .send({ reservePercent: -0.1 });
  assert.equal(tooLow.status, 400);
});

test('PUT /api/tax/reserve/settings/:currency: rejects bad currency code', async () => {
  const res = await primaryAgent
    .put('/api/tax/reserve/settings/CA')
    .send({ reservePercent: 0.25 });
  assert.equal(res.status, 400);
});

test('PUT /api/tax/reserve/settings/:currency: lowercase currency normalised to uppercase', async () => {
  const res = await primaryAgent
    .put('/api/tax/reserve/settings/usd')
    .send({ reservePercent: 0.28 });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.currency, 'USD');
});

test('PUT /api/tax/reserve/settings/:currency: scoped to household', async () => {
  // Primary just wrote CAD = 0.35. Other household has no row — should see
  // a synthesised default (or nothing if no observed currency).
  const otherList = await otherAgent.get('/api/tax/reserve/settings');
  assert.equal(otherList.status, 200);
  // Other household has no transactions yet, so no synthesised defaults either.
  const cad = otherList.body.data.find((r: { currency: string }) => r.currency === 'CAD');
  assert.equal(cad, undefined);
});

// ---- DELETE /api/tax/reserve/settings/:currency ------------------------

test('DELETE /api/tax/reserve/settings/:currency: removes the row', async () => {
  const del = await primaryAgent.delete('/api/tax/reserve/settings/USD');
  assert.equal(del.status, 204);
  // GET should re-synth a default for USD because there's still a USD txn.
  const list = await primaryAgent.get('/api/tax/reserve/settings');
  const usd = list.body.data.find((r: { currency: string }) => r.currency === 'USD');
  assert.equal(usd.isDefault, true);
  assert.equal(usd.reservePercent, '0.2500');
});

test('DELETE /api/tax/reserve/settings/:currency: idempotent when no row exists', async () => {
  const del = await primaryAgent.delete('/api/tax/reserve/settings/EUR');
  assert.equal(del.status, 204);
});

// ---- GET /api/tax/reserve/summary --------------------------------------

test('GET /api/tax/reserve/summary: per-quarter rollup with applied percent', async () => {
  // Seed Q1 business income + expense in CAD with HST.
  // Use the OTHER household for isolation from the earlier tests.
  await createTransaction(otherHouseholdId, otherAccountId, '2026-01-15', 4000, {
    business: true,
    hstGstAmount: 520,
  });
  await createTransaction(otherHouseholdId, otherAccountId, '2026-02-20', -1000, {
    business: true,
    hstGstAmount: 130,
    deductiblePercent: 1,
  });
  // Set explicit reserve percent so the test pins to a deterministic number.
  await otherAgent
    .put('/api/tax/reserve/settings/CAD')
    .send({ reservePercent: 0.25, note: 'Federal + ON' });

  const res = await otherAgent.get(
    '/api/tax/reserve/summary?periodicity=quarterly&from=2026-01-01&to=2026-12-31',
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.periodicity, 'quarterly');
  assert.equal(res.body.scope, 'business');
  assert.match(res.body.disclaimer, /Not tax filing advice/i);
  assert.equal(res.body.data.length, 1);
  const q1 = res.body.data[0];
  assert.equal(q1.period, '2026-Q1');
  assert.equal(q1.currency, 'CAD');
  assert.equal(q1.components.businessIncome, 4000);
  assert.equal(q1.components.deductibleExpenses, 1000);
  assert.equal(q1.components.hstGstCollected, 520);
  assert.equal(q1.components.hstGstPaid, 130);
  assert.equal(q1.netBusinessIncome, 3000);
  assert.equal(q1.netHstGst, 390);
  assert.equal(q1.reservePercent, 0.25);
  // 3000 * 0.25 = 750 + 390 = 1140
  assert.equal(q1.reserveTarget, 1140);
});

test('GET /api/tax/reserve/summary: monthly buckets', async () => {
  const res = await otherAgent.get(
    '/api/tax/reserve/summary?periodicity=monthly&from=2026-01-01&to=2026-12-31',
  );
  assert.equal(res.status, 200);
  // Q1 had Jan income + Feb expense — should split into 2026-01 and 2026-02.
  const periods = res.body.data.map((r: { period: string }) => r.period).sort();
  assert.ok(periods.includes('2026-01'));
  assert.ok(periods.includes('2026-02'));
});

test('GET /api/tax/reserve/summary: rejects unknown periodicity (falls back to quarterly)', async () => {
  const res = await otherAgent.get(
    '/api/tax/reserve/summary?periodicity=weekly&from=2026-01-01&to=2026-12-31',
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.periodicity, 'quarterly');
});

test('GET /api/tax/reserve/summary: cross-household isolation', async () => {
  // Primary's only txn earlier was 2026-03-01 (Q1) — and it has no metadata
  // so it just contributes to gross business income.
  const res = await primaryAgent.get(
    '/api/tax/reserve/summary?periodicity=quarterly&from=2026-01-01&to=2026-12-31',
  );
  assert.equal(res.status, 200);
  // Should NOT see Other's Q1 row.
  for (const row of res.body.data) {
    // Primary's CAD txn at 2026-03-01 is income (positive) — its own Q1 row.
    // What we're checking: primary's businessIncome ≠ Other's 4000.
    if (row.currency === 'CAD' && row.period === '2026-Q1') {
      assert.notEqual(row.components.businessIncome, 4000);
    }
  }
});

test('GET /api/tax/reserve/summary: ignores non-business scope rows', async () => {
  // Seed a personal txn — should not show up in business scope summary.
  await createTransaction(otherHouseholdId, otherAccountId, '2026-04-01', 5000, {
    business: false,
  });
  const res = await otherAgent.get(
    '/api/tax/reserve/summary?periodicity=quarterly&from=2026-01-01&to=2026-12-31',
  );
  assert.equal(res.status, 200);
  const q2 = res.body.data.find(
    (r: { period: string; currency: string }) => r.period === '2026-Q2' && r.currency === 'CAD',
  );
  // Q2 shouldn't even exist because the only Q2 txn was non-business.
  assert.equal(q2, undefined);
});
