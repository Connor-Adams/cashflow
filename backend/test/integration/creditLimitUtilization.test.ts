/**
 * Integration tests for credit-limit + utilization (#437).
 *
 * Covers:
 *  - PATCH /api/accounts/:id creditLimit set / unset / validation.
 *  - PATCH rejects non-null creditLimit for non-credit-card accounts (400).
 *  - GET /api/accounts enriches each row with creditLimit + utilizationPct.
 *  - Closed credit cards report null utilizationPct.
 *  - Over-limit (>100%) shows the actual pct without clamping (frontend handles
 *    the ">100% — over limit" copy).
 *  - GET /api/net-worth/credit-utilization aggregates per currency and excludes
 *    closed cards.
 *  - PUT /api/credit-cards/:accountId accepts creditLimit on the sidecar.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let primaryAgent: ReturnType<typeof request.agent>;
let primaryHouseholdId: number;
let primaryUserId: number;
let checkingAccountId: number;
let cardAccountId: number;
let secondCardAccountId: number;
let closedCardAccountId: number;
let usdCardAccountId: number;
let testDb: PgTestDb;

type SeededAccount = { id: number };

async function makeAccount(opts: {
  householdId: number;
  userId: number;
  name: string;
  accountType: string;
  defaultCurrency?: string;
  closedAt?: string | null;
}): Promise<SeededAccount> {
  const models = await import('../../src/models');
  const account = await models.Account.create({
    householdId: opts.householdId,
    ownerUserId: opts.userId,
    owner: 'me',
    visibility: 'shared',
    name: opts.name,
    accountType: opts.accountType,
    defaultCurrency: opts.defaultCurrency ?? 'CAD',
    shortCode: opts.name.slice(0, 3).toUpperCase(),
    openingBalance: '0',
    openingBalanceDate: '2026-01-01',
    closedAt: opts.closedAt ?? null,
  });
  return { id: account.id };
}

async function postTxn(
  accountId: number,
  householdId: number,
  amount: number,
  currency = 'CAD',
): Promise<void> {
  const models = await import('../../src/models');
  const fp = `cl-${accountId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await models.Transaction.create({
    accountId,
    householdId,
    date: '2026-02-01',
    amount: String(amount),
    currency,
    merchantRaw: 'charge',
    merchantClean: 'charge',
    importBatch: 'test',
    sourceRowFingerprint: fp,
    sourceIdentityFingerprint: fp,
  } as never);
}

type Seeded = { token: string; householdId: number; userId: number };

async function seedHousehold(emailPrefix: string): Promise<Seeded> {
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
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  await models.Session.create({ userId: user.id, tokenHash: hashToken(token), expiresAt });
  return { token, householdId: household.id, userId: user.id };
}

before(async () => {
  process.env.NODE_ENV = 'test';
  testDb = await setupPgTestDb('credit_limit_util');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const bootstrap = request.agent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'super-cl@example.com',
    displayName: 'Super CL',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const primary = await seedHousehold('PrimaryCL');
  primaryHouseholdId = primary.householdId;
  primaryUserId = primary.userId;
  primaryAgent = request.agent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  // Cash account — non-credit, used to prove PATCH 400 path.
  const checking = await makeAccount({
    householdId: primary.householdId,
    userId: primary.userId,
    name: 'Chequing',
    accountType: 'checking',
  });
  checkingAccountId = checking.id;

  // Card 1 — owed 600 CAD; will be set to limit 2000 → 30% utilization.
  const card = await makeAccount({
    householdId: primary.householdId,
    userId: primary.userId,
    name: 'VisaCL',
    accountType: 'credit_card',
  });
  cardAccountId = card.id;
  await postTxn(cardAccountId, primary.householdId, -600);

  // Card 2 — over-limit case: owed 1500 against a limit of 1000 → 150%.
  const card2 = await makeAccount({
    householdId: primary.householdId,
    userId: primary.userId,
    name: 'OverCL',
    accountType: 'credit_card',
  });
  secondCardAccountId = card2.id;
  await postTxn(secondCardAccountId, primary.householdId, -1500);

  // Closed card with a balance + limit — must not appear in utilization.
  const closedCard = await makeAccount({
    householdId: primary.householdId,
    userId: primary.userId,
    name: 'ClosedCL',
    accountType: 'credit_card',
    closedAt: '2026-01-15',
  });
  closedCardAccountId = closedCard.id;
  await postTxn(closedCardAccountId, primary.householdId, -300);

  // USD-denominated card for currency segmentation.
  const usdCard = await makeAccount({
    householdId: primary.householdId,
    userId: primary.userId,
    name: 'UsdCL',
    accountType: 'credit_card',
    defaultCurrency: 'USD',
  });
  usdCardAccountId = usdCard.id;
  await postTxn(usdCardAccountId, primary.householdId, -200, 'USD');
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// AC #2: PATCH accepts creditLimit for credit_card; rejects for non-credit with 400.
test('PATCH /api/accounts/:id accepts creditLimit for credit_card', async () => {
  const res = await primaryAgent
    .patch(`/api/accounts/${cardAccountId}`)
    .send({ creditLimit: 2000 });
  assert.equal(res.status, 200);
  assert.equal(Number(res.body.creditLimit), 2000);
  // utilizationPct = 600 / 2000 * 100 = 30
  assert.equal(Math.round(Number(res.body.utilizationPct)), 30);
});

test('PATCH /api/accounts/:id rejects creditLimit on non-credit account', async () => {
  const res = await primaryAgent
    .patch(`/api/accounts/${checkingAccountId}`)
    .send({ creditLimit: 1000 });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /credit_card/i);
});

// AC #11: creditLimit = 0 blocked with 400.
test('PATCH /api/accounts/:id rejects creditLimit <= 0', async () => {
  const res0 = await primaryAgent
    .patch(`/api/accounts/${cardAccountId}`)
    .send({ creditLimit: 0 });
  assert.equal(res0.status, 400);
  const resNeg = await primaryAgent
    .patch(`/api/accounts/${cardAccountId}`)
    .send({ creditLimit: -50 });
  assert.equal(resNeg.status, 400);
});

test('PATCH /api/accounts/:id accepts null creditLimit to clear', async () => {
  // Seed a limit
  await primaryAgent.patch(`/api/accounts/${cardAccountId}`).send({ creditLimit: 2000 });
  const res = await primaryAgent
    .patch(`/api/accounts/${cardAccountId}`)
    .send({ creditLimit: null });
  assert.equal(res.status, 200);
  assert.equal(res.body.creditLimit, null);
  assert.equal(res.body.utilizationPct, null);
});

// AC #3, #8, #10: GET enriches with creditLimit + utilizationPct; over-limit
// reports raw pct; closed cards report null pct.
test('GET /api/accounts enriches credit cards with creditLimit + utilizationPct; closed=null', async () => {
  // Re-set limits to known values for this assertion.
  await primaryAgent.patch(`/api/accounts/${cardAccountId}`).send({ creditLimit: 2000 });
  await primaryAgent.patch(`/api/accounts/${secondCardAccountId}`).send({ creditLimit: 1000 });
  // closed card limit set BEFORE close — but we set it now via the PATCH; the
  // PATCH succeeds (kind is credit_card), but utilizationPct should remain
  // null because the card is closed.
  await primaryAgent.patch(`/api/accounts/${closedCardAccountId}`).send({ creditLimit: 500 });
  await primaryAgent.patch(`/api/accounts/${usdCardAccountId}`).send({ creditLimit: 1000 });

  const res = await primaryAgent.get('/api/accounts');
  assert.equal(res.status, 200);
  const accounts = res.body as Array<{
    id: number;
    accountType: string;
    creditLimit: number | null;
    utilizationPct: number | null;
    currentBalance: number | null;
  }>;
  const byId = new Map(accounts.map((a) => [a.id, a]));

  const card1 = byId.get(cardAccountId);
  assert.ok(card1);
  assert.equal(Number(card1.creditLimit), 2000);
  assert.equal(Math.round(Number(card1.utilizationPct)), 30);
  assert.equal(Number(card1.currentBalance), 600);

  // Over-limit card reports raw 150%, not clamped — frontend renders ">100%"
  // copy. AC #8 validates that the badge re-derives this client-side.
  const card2 = byId.get(secondCardAccountId);
  assert.ok(card2);
  assert.equal(Number(card2.creditLimit), 1000);
  assert.equal(Math.round(Number(card2.utilizationPct)), 150);

  // AC #10: closed cards do NOT contribute to utilization.
  const closed = byId.get(closedCardAccountId);
  assert.ok(closed);
  assert.equal(closed.utilizationPct, null);

  // Non-credit account reports null on the new fields.
  const cash = byId.get(checkingAccountId);
  assert.ok(cash);
  assert.equal(cash.creditLimit, null);
  assert.equal(cash.utilizationPct, null);
  assert.equal(cash.currentBalance, null);
});

// AC #9: Dashboard utilization summary segments by currency.
test('GET /api/net-worth/credit-utilization segments by currency, excludes closed', async () => {
  // Limits already set from the previous test; if isolation matters add a
  // small refresh PATCH here. Re-PATCH to be deterministic.
  await primaryAgent.patch(`/api/accounts/${cardAccountId}`).send({ creditLimit: 2000 });
  await primaryAgent.patch(`/api/accounts/${secondCardAccountId}`).send({ creditLimit: 1000 });
  await primaryAgent.patch(`/api/accounts/${closedCardAccountId}`).send({ creditLimit: 500 });
  await primaryAgent.patch(`/api/accounts/${usdCardAccountId}`).send({ creditLimit: 1000 });

  const res = await primaryAgent.get('/api/net-worth/credit-utilization');
  assert.equal(res.status, 200);
  const buckets = res.body as Array<{
    currency: string;
    utilizationPct: number;
    cardCount: number;
    totalBalance: number;
    totalLimit: number;
    byCard: Array<{ accountId: number; utilizationPct: number }>;
  }>;

  const cad = buckets.find((b) => b.currency === 'CAD');
  const usd = buckets.find((b) => b.currency === 'USD');
  assert.ok(cad, 'expected a CAD bucket');
  assert.ok(usd, 'expected a USD bucket');

  // CAD: card1 (600/2000) + card2 (1500/1000) = 2100 / 3000 = 70%; 2 active cards.
  assert.equal(cad.cardCount, 2);
  assert.equal(Math.round(cad.utilizationPct), 70);

  // Closed card must NOT be in the CAD bucket.
  assert.equal(
    cad.byCard.some((c) => c.accountId === closedCardAccountId),
    false,
  );

  // USD: 200 / 1000 = 20%, single card.
  assert.equal(usd.cardCount, 1);
  assert.equal(Math.round(usd.utilizationPct), 20);
});

// AC: PUT /api/credit-cards/:accountId also accepts creditLimit on the sidecar.
test('PUT /api/credit-cards/:accountId persists creditLimit on the sidecar', async () => {
  const put = await primaryAgent.put(`/api/credit-cards/${cardAccountId}`).send({
    creditLimit: 2500,
  });
  assert.equal(put.status, 200);
  assert.equal(Number(put.body.creditLimit), 2500);

  // GET reflects the new value.
  const res = await primaryAgent.get('/api/accounts');
  const card = (res.body as Array<{ id: number; creditLimit: number | null }>).find(
    (a) => a.id === cardAccountId,
  );
  assert.equal(Number(card?.creditLimit), 2500);
});

test('PUT /api/credit-cards/:accountId rejects creditLimit <= 0', async () => {
  const res = await primaryAgent.put(`/api/credit-cards/${cardAccountId}`).send({
    creditLimit: 0,
  });
  assert.equal(res.status, 400);
});

// Reference: keep household variable referenced so eslint no-unused-vars stays quiet.
test('household + user ids are linked to the seed (sanity)', () => {
  assert.ok(primaryHouseholdId > 0);
  assert.ok(primaryUserId > 0);
});
