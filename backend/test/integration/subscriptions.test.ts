/**
 * Integration tests for /api/subscriptions (Cashflow #205). Run in isolation
 * (`yarn test:integration`) so DATABASE_URL is set before any Sequelize
 * import.
 *
 * Mirrors the bootstrap pattern used by budgets.test.ts: seed a superadmin
 * to satisfy the global registration guard, then seed two non-superadmin
 * households so cross-household isolation can be exercised via real session
 * cookies.
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
let testDb: PgTestDb;

type Seeded = {
  token: string;
  householdId: number;
  userId: number;
  accountId: number;
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

async function seedRecurringCharges(
  householdId: number,
  accountId: number,
  merchant: string,
  amount: number,
  count: number,
  startDaysAgo = 10,
): Promise<void> {
  const models = await import('../../src/models');
  // Backdate charges so the most recent is `startDaysAgo` days ago and
  // prior ones are ~one month apart — keeps everything inside the default
  // 180-day window.
  const now = new Date();
  for (let i = 0; i < count; i += 1) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - startDaysAgo - i * 30);
    const iso = d.toISOString().slice(0, 10);
    await models.Transaction.create({
      accountId,
      householdId,
      visibility: 'shared',
      ownershipType: 'me',
      ownershipContactId: null,
      importBatch: 'subscriptions-test',
      date: iso,
      merchantRaw: merchant,
      merchantClean: merchant,
      amount: (-Math.abs(amount)).toFixed(4),
      currency: 'CAD',
      notes: null,
      sourceReference: null,
      sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
      sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
      appliedRuleId: null,
      autoCategory: null,
      categoryOverride: null,
      finalCategory: 'Streaming',
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
}

before(async () => {
  testDb = await setupPgTestDb('subscriptions');

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
  void otherHouseholdId;
  otherAgent = request.agent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/subscriptions detects from recurring charges and persists rows', async () => {
  await seedRecurringCharges(primaryHouseholdId, primaryAccountId, 'Netflix', 15.99, 4);

  const res = await primaryAgent.get('/api/subscriptions');
  assert.equal(res.status, 200);
  const items = res.body.items as Array<{
    id: number;
    merchantName: string;
    normalizedName: string;
    amount: string;
    currency: string;
    cadence: string;
    status: string;
    annualizedCost: string;
    priceChangeDetected: boolean;
  }>;
  const netflix = items.find((i) => i.normalizedName === 'netflix');
  assert.ok(netflix, 'should detect Netflix as a subscription');
  assert.equal(netflix!.currency, 'CAD');
  assert.equal(netflix!.cadence, 'monthly');
  assert.equal(netflix!.status, 'active');
  // 15.99 * 12 = 191.88
  assert.equal(Number(netflix!.annualizedCost), 191.88);
  assert.equal(netflix!.priceChangeDetected, false);
});

test('PATCH /api/subscriptions/:id updates status without losing detection data', async () => {
  const list = await primaryAgent.get('/api/subscriptions?refresh=0');
  const netflix = (
    list.body.items as Array<{ id: number; normalizedName: string }>
  ).find((i) => i.normalizedName === 'netflix');
  assert.ok(netflix);
  const id = netflix!.id;

  const patched = await primaryAgent
    .patch(`/api/subscriptions/${id}`)
    .send({ status: 'ignored', cancellationUrl: 'https://netflix.com/cancel' });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.status, 'ignored');
  assert.equal(patched.body.cancellationUrl, 'https://netflix.com/cancel');
});

test('PATCH /api/subscriptions/:id rejects invalid status', async () => {
  const list = await primaryAgent.get('/api/subscriptions?refresh=0');
  const id = (list.body.items as Array<{ id: number }>)[0].id;
  const res = await primaryAgent
    .patch(`/api/subscriptions/${id}`)
    .send({ status: 'pending' });
  assert.equal(res.status, 400);
});

// ----- #291: editable cadence -----

test('PATCH /api/subscriptions/:id accepts cadence and recomputes annual cost (AC #1, #2)', async () => {
  const list = await primaryAgent.get('/api/subscriptions?refresh=0');
  const netflix = (
    list.body.items as Array<{
      id: number;
      normalizedName: string;
      amount: string;
    }>
  ).find((i) => i.normalizedName === 'netflix');
  assert.ok(netflix);
  const perPeriod = Number(netflix!.amount); // 15.99

  const patched = await primaryAgent
    .patch(`/api/subscriptions/${netflix!.id}`)
    .send({ cadence: 'annual' });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.cadence, 'annual');
  // Annualized cost for an annual cadence equals the per-period amount.
  assert.equal(Number(patched.body.annualizedCost), Number(perPeriod.toFixed(4)));

  // Restore monthly so later tests see the original cadence; annual cost goes
  // back to amount * 12.
  const restored = await primaryAgent
    .patch(`/api/subscriptions/${netflix!.id}`)
    .send({ cadence: 'monthly' });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.cadence, 'monthly');
  assert.equal(Number(restored.body.annualizedCost), Number((perPeriod * 12).toFixed(4)));
});

test('PATCH /api/subscriptions/:id rejects an invalid cadence with INVALID_CADENCE (AC #1)', async () => {
  const list = await primaryAgent.get('/api/subscriptions?refresh=0');
  const id = (list.body.items as Array<{ id: number }>)[0].id;
  const res = await primaryAgent
    .patch(`/api/subscriptions/${id}`)
    .send({ cadence: 'fortnightly' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'INVALID_CADENCE');
});

test('PATCH /api/subscriptions/:id accepts each of the five cadence values (AC #2)', async () => {
  const list = await primaryAgent.get('/api/subscriptions?refresh=0');
  const id = (list.body.items as Array<{ id: number }>)[0].id;
  for (const cadence of ['weekly', 'monthly', 'quarterly', 'semiannual', 'annual']) {
    const res = await primaryAgent
      .patch(`/api/subscriptions/${id}`)
      .send({ cadence });
    assert.equal(res.status, 200, `cadence ${cadence} should be accepted`);
    assert.equal(res.body.cadence, cadence);
  }
  // Leave the row on monthly for downstream tests.
  await primaryAgent.patch(`/api/subscriptions/${id}`).send({ cadence: 'monthly' });
});

// ----- #291: cancel-impact endpoint -----

test('GET /api/subscriptions/:id/cancel-impact projects monthly spend over 12 months (AC #3, #5)', async () => {
  // Seed a clean $20/mo subscription so the AC #5 numbers are exact.
  await seedRecurringCharges(primaryHouseholdId, primaryAccountId, 'AcmePlus', 20, 4);
  const list = await primaryAgent.get('/api/subscriptions');
  const acme = (
    list.body.items as Array<{ id: number; normalizedName: string; cadence: string }>
  ).find((i) => i.normalizedName === 'acmeplus');
  assert.ok(acme);
  assert.equal(acme!.cadence, 'monthly');

  const res = await primaryAgent.get(
    `/api/subscriptions/${acme!.id}/cancel-impact?horizonMonths=12`,
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.amount, 240);
  assert.equal(res.body.count, 12);
  assert.equal(res.body.horizonMonths, 12);
  assert.equal(res.body.currency, 'CAD');
});

test('GET cancel-impact reflects a corrected cadence (annual → count 1, AC #5)', async () => {
  const list = await primaryAgent.get('/api/subscriptions?refresh=0');
  const acme = (
    list.body.items as Array<{ id: number; normalizedName: string }>
  ).find((i) => i.normalizedName === 'acmeplus');
  assert.ok(acme);
  // Correct the cadence to annual; the per-period amount ($20) is unchanged,
  // so a 12-month horizon now sees exactly one $20 occurrence.
  await primaryAgent.patch(`/api/subscriptions/${acme!.id}`).send({ cadence: 'annual' });
  const res = await primaryAgent.get(
    `/api/subscriptions/${acme!.id}/cancel-impact?horizonMonths=12`,
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.amount, 20);
  // Restore for tidiness.
  await primaryAgent.patch(`/api/subscriptions/${acme!.id}`).send({ cadence: 'monthly' });
});

test('GET cancel-impact rejects a horizon outside {6, 12, 24} (AC #4)', async () => {
  const list = await primaryAgent.get('/api/subscriptions?refresh=0');
  const id = (list.body.items as Array<{ id: number }>)[0].id;
  for (const bad of ['18', '1', '0', 'abc', '12.5']) {
    const res = await primaryAgent.get(
      `/api/subscriptions/${id}/cancel-impact?horizonMonths=${bad}`,
    );
    assert.equal(res.status, 400, `horizonMonths=${bad} should be rejected`);
  }
});

test('GET cancel-impact accepts the 6 and 24 month horizons (AC #4)', async () => {
  const list = await primaryAgent.get('/api/subscriptions?refresh=0');
  const acme = (
    list.body.items as Array<{ id: number; normalizedName: string }>
  ).find((i) => i.normalizedName === 'acmeplus');
  assert.ok(acme);
  const six = await primaryAgent.get(
    `/api/subscriptions/${acme!.id}/cancel-impact?horizonMonths=6`,
  );
  assert.equal(six.status, 200);
  assert.equal(six.body.amount, 120);
  assert.equal(six.body.count, 6);
  const twentyFour = await primaryAgent.get(
    `/api/subscriptions/${acme!.id}/cancel-impact?horizonMonths=24`,
  );
  assert.equal(twentyFour.status, 200);
  assert.equal(twentyFour.body.amount, 480);
  assert.equal(twentyFour.body.count, 24);
});

test('GET cancel-impact does not leak another household subscription (AC #12)', async () => {
  const list = await primaryAgent.get('/api/subscriptions?refresh=0');
  const id = (list.body.items as Array<{ id: number }>)[0].id;
  const res = await otherAgent.get(
    `/api/subscriptions/${id}/cancel-impact?horizonMonths=12`,
  );
  assert.equal(res.status, 404);
});

test('PATCH cadence is rejected across households (AC #12)', async () => {
  const list = await primaryAgent.get('/api/subscriptions?refresh=0');
  const id = (list.body.items as Array<{ id: number }>)[0].id;
  const res = await otherAgent
    .patch(`/api/subscriptions/${id}`)
    .send({ cadence: 'annual' });
  assert.equal(res.status, 404);
});

test('PATCH /api/subscriptions/:id rejects non-http cancellationUrl', async () => {
  const list = await primaryAgent.get('/api/subscriptions?refresh=0');
  const id = (list.body.items as Array<{ id: number }>)[0].id;
  const res = await primaryAgent
    .patch(`/api/subscriptions/${id}`)
    .send({ cancellationUrl: 'javascript:alert(1)' });
  assert.equal(res.status, 400);
});

test('refresh preserves user-edited status across detection runs', async () => {
  // The previous test marked Netflix ignored. After a refresh-on-read the
  // status should still be ignored — only detection-derived fields change.
  const res = await primaryAgent.get('/api/subscriptions');
  assert.equal(res.status, 200);
  const netflix = (
    res.body.items as Array<{
      normalizedName: string;
      status: string;
      cancellationUrl: string | null;
    }>
  ).find((i) => i.normalizedName === 'netflix');
  assert.ok(netflix);
  assert.equal(netflix!.status, 'ignored');
  assert.equal(netflix!.cancellationUrl, 'https://netflix.com/cancel');
});

test('GET /api/subscriptions/summary aggregates active counts and totals', async () => {
  const res = await primaryAgent.get('/api/subscriptions/summary?refresh=0');
  assert.equal(res.status, 200);
  const { totals, byCurrency } = res.body as {
    totals: {
      active: number;
      ignored: number;
      cancelled: number;
      unknown: number;
      priceChangeDetected: number;
    };
    byCurrency: Array<{
      currency: string;
      activeCount: number;
      monthlyCost: number;
      annualCost: number;
    }>;
  };
  // Netflix was marked ignored in the test above.
  assert.equal(totals.ignored >= 1, true);
  // No active subscriptions left — Netflix is the only one we seeded and it's ignored.
  assert.equal(totals.active, 0);
  // byCurrency rolls up active subs only, so it should be empty.
  assert.equal(byCurrency.length, 0);
});

test('GET /api/subscriptions does not leak other households rows', async () => {
  await seedRecurringCharges(primaryHouseholdId, primaryAccountId, 'Spotify', 9.99, 4);
  // Other household's view should not see Primary household's subscriptions.
  const otherList = await otherAgent.get('/api/subscriptions');
  assert.equal(otherList.status, 200);
  const otherItems = (otherList.body.items as Array<{ normalizedName: string }>);
  assert.equal(
    otherItems.find((i) => i.normalizedName === 'netflix'),
    undefined,
  );
  assert.equal(
    otherItems.find((i) => i.normalizedName === 'spotify'),
    undefined,
  );
});

test('PATCH /api/subscriptions/:id returns 404 across households', async () => {
  const list = await primaryAgent.get('/api/subscriptions?refresh=0');
  const id = (list.body.items as Array<{ id: number }>)[0].id;
  const res = await otherAgent.patch(`/api/subscriptions/${id}`).send({ status: 'active' });
  assert.equal(res.status, 404);
});

test('detected price increase flags a row when amount changes above threshold', async () => {
  // Seed Hulu at 9.99 four times centred ~5 months ago, then refresh so the
  // detector persists a $9.99 baseline.
  await seedRecurringCharges(primaryHouseholdId, primaryAccountId, 'Hulu', 9.99, 4, 30);
  await primaryAgent.get('/api/subscriptions'); // first refresh — establishes baseline

  // Now wipe Hulu's charges and re-seed at a higher amount so the new
  // detection-derived avgAmount is well above the persisted $9.99. We
  // can't just append — that would mix old + new amounts into the same
  // detector group, blunting the change. Detection persistence reads the
  // PERSISTED amount and compares it to the freshly-computed avg, so a
  // clean swap is the cleanest way to provoke a real "price up" signal.
  const models = await import('../../src/models');
  await models.Transaction.destroy({
    where: { householdId: primaryHouseholdId, merchantClean: 'Hulu' },
  });
  await seedRecurringCharges(primaryHouseholdId, primaryAccountId, 'Hulu', 14, 4, 10);

  const res = await primaryAgent.get('/api/subscriptions');
  const hulu = (
    res.body.items as Array<{
      normalizedName: string;
      amount: string;
      priceChangeDetected: boolean;
    }>
  ).find((i) => i.normalizedName === 'hulu');
  assert.ok(hulu);
  // 14 / 9.99 ≈ 1.40 → 40% increase, well above the 10% threshold.
  assert.equal(hulu!.priceChangeDetected, true);
});
