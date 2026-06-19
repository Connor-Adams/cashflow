/**
 * Integration tests for /api/credit-cards (issue #243, credit-card payment
 * planner). OPERATIONAL bill management — distinct from #202's payoff strategy:
 * statement vs current vs minimum balance, due-date warnings, autopay status,
 * forecast integration, and mark-paid / link-transaction.
 *
 * Mirrors the seed pattern from debt.test.ts: bootstrap a superadmin, then seed
 * two households so cross-household isolation is exercised. The primary
 * household gets a checking account (the bill's funding account) plus a credit
 * card with a transaction-derived owed balance.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let primaryAgent: ReturnType<typeof request.agent>;
let otherAgent: ReturnType<typeof request.agent>;
let primaryHouseholdId: number;
let checkingAccountId: number;
let cardAccountId: number;
let otherCardAccountId: number;
let testDb: PgTestDb;

type SeededAccount = { id: number };

async function makeAccount(opts: {
  householdId: number;
  userId: number;
  name: string;
  accountType: string;
}): Promise<SeededAccount> {
  const models = await import('../../src/models');
  const account = await models.Account.create({
    householdId: opts.householdId,
    ownerUserId: opts.userId,
    owner: 'me',
    visibility: 'shared',
    name: opts.name,
    accountType: opts.accountType,
    defaultCurrency: 'CAD',
    shortCode: opts.name.slice(0, 3).toUpperCase(),
    openingBalance: '0',
    openingBalanceDate: '2026-01-01',
  });
  return { id: account.id };
}

/** Post a transaction so an account has a transaction-derived balance. */
async function postTxn(
  accountId: number,
  householdId: number,
  amount: number,
): Promise<void> {
  const models = await import('../../src/models');
  const fp = `cc-t-${accountId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await models.Transaction.create({
    accountId,
    householdId,
    date: '2026-02-01',
    amount: String(amount),
    currency: 'CAD',
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
  testDb = await setupPgTestDb('credit_cards');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const bootstrap = testAgent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const primary = await seedHousehold('Primary');
  primaryHouseholdId = primary.householdId;
  primaryAgent = testAgent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  // Funding (cash) account with a positive balance — used as paymentAccountId
  // and to give safe-to-spend some cash to work with.
  const checking = await makeAccount({
    householdId: primary.householdId,
    userId: primary.userId,
    name: 'Chequing',
    accountType: 'checking',
  });
  checkingAccountId = checking.id;
  await postTxn(checkingAccountId, primary.householdId, 5000); // +5000 cash on hand

  // Credit card with a derived owed balance of 1200 (charges are negative).
  const card = await makeAccount({
    householdId: primary.householdId,
    userId: primary.userId,
    name: 'Visa',
    accountType: 'credit_card',
  });
  cardAccountId = card.id;
  await postTxn(cardAccountId, primary.householdId, -1200); // owes 1200 currently

  const other = await seedHousehold('Other');
  otherAgent = testAgent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
  const otherCard = await makeAccount({
    householdId: other.householdId,
    userId: other.userId,
    name: 'Amex',
    accountType: 'credit_card',
  });
  otherCardAccountId = otherCard.id;
  await postTxn(otherCardAccountId, other.householdId, -800);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// AC: existing account behavior remains compatible — only credit cards listed.
test('GET /api/credit-cards lists only credit_card accounts with derived current balance', async () => {
  const res = await primaryAgent.get('/api/credit-cards');
  assert.equal(res.status, 200);
  const cards = res.body.cards as Array<{
    accountId: number;
    name: string;
    currentBalance: number;
    statementBalance: number | null;
    minimumPayment: number;
    autopayEnabled: boolean;
  }>;
  assert.equal(cards.length, 1);
  const card = cards[0];
  assert.equal(card.accountId, cardAccountId);
  // Current balance is the transaction-derived owed amount (positive).
  assert.equal(card.currentBalance, 1200);
  // No profile configured yet → defaults.
  assert.equal(card.statementBalance, null);
  assert.equal(card.minimumPayment, 0);
  assert.equal(card.autopayEnabled, false);
});

// AC: user can configure credit card payment metadata.
test('PUT /api/credit-cards/:accountId persists CC payment metadata', async () => {
  const put = await primaryAgent.put(`/api/credit-cards/${cardAccountId}`).send({
    statementBalance: 1000,
    minimumPayment: 35,
    dueDay: 15,
    statementDate: '2026-02-20',
    autopayEnabled: true,
    autopayType: 'minimum',
    paymentAccountId: checkingAccountId,
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.statementBalance, 1000);
  assert.equal(put.body.minimumPayment, 35);
  assert.equal(put.body.dueDay, 15);
  assert.equal(put.body.statementDate, '2026-02-20');
  assert.equal(put.body.autopayEnabled, true);
  assert.equal(put.body.autopayType, 'minimum');
  assert.equal(put.body.paymentAccountId, checkingAccountId);

  // Second PUT updates in place (1:1, no duplicate row).
  const put2 = await primaryAgent.put(`/api/credit-cards/${cardAccountId}`).send({
    minimumPayment: 40,
    autopayEnabled: false,
  });
  assert.equal(put2.status, 200);
  assert.equal(put2.body.minimumPayment, 40);
  assert.equal(put2.body.autopayEnabled, false);
  // autopayType is cleared when autopay is turned off.
  assert.equal(put2.body.autopayType, null);
});

// AC: app distinguishes current balance, statement balance, and minimum payment.
test('GET /api/credit-cards distinguishes current vs statement vs minimum', async () => {
  const res = await primaryAgent.get('/api/credit-cards');
  const card = (res.body.cards as Array<{
    accountId: number;
    currentBalance: number;
    statementBalance: number | null;
    minimumPayment: number;
  }>).find((c) => c.accountId === cardAccountId);
  assert.ok(card);
  // All three are independent figures.
  assert.equal(card.currentBalance, 1200); // derived from transactions
  assert.equal(card.statementBalance, 1000); // user-entered snapshot
  assert.equal(card.minimumPayment, 40); // user-entered minimum
});

// AC: app shows upcoming statement due dates.
test('GET /api/credit-cards surfaces the next due date and a due-soon warning', async () => {
  const res = await primaryAgent.get('/api/credit-cards').query({ asOfDate: '2026-03-10' });
  const card = (res.body.cards as Array<{
    accountId: number;
    dueDay: number | null;
    nextDueDate: string | null;
    daysUntilDue: number | null;
    dueSoon: boolean;
  }>).find((c) => c.accountId === cardAccountId);
  assert.ok(card);
  // dueDay=15, asOf 2026-03-10 → next due 2026-03-15 (5 days out).
  assert.equal(card.nextDueDate, '2026-03-15');
  assert.equal(card.daysUntilDue, 5);
  assert.equal(card.dueSoon, true);
});

test('PUT /api/credit-cards/:accountId rejects a non-credit-card account', async () => {
  const put = await primaryAgent.put(`/api/credit-cards/${checkingAccountId}`).send({
    minimumPayment: 10,
  });
  assert.equal(put.status, 400);
});

test('PUT /api/credit-cards/:accountId 404s for a card in another household', async () => {
  const put = await primaryAgent.put(`/api/credit-cards/${otherCardAccountId}`).send({
    minimumPayment: 10,
  });
  assert.equal(put.status, 404);
});

test('PUT /api/credit-cards/:accountId rejects a payment account from another household', async () => {
  const put = await primaryAgent.put(`/api/credit-cards/${cardAccountId}`).send({
    paymentAccountId: otherCardAccountId,
  });
  assert.equal(put.status, 400);
});

// AC: planned card payments can appear in forecast.
test('POST /api/credit-cards/:accountId/payment creates a forecast planned event', async () => {
  const res = await primaryAgent.post(`/api/credit-cards/${cardAccountId}/payment`).send({
    amountStrategy: 'statement',
    asOfDate: '2026-03-10',
  });
  assert.equal(res.status, 201);
  assert.ok(res.body.plannedEvent);
  assert.equal(res.body.plannedEvent.source, 'credit_card');
  assert.equal(res.body.plannedEvent.type, 'debt_payment');
  // 'statement' strategy pays the statement balance (1000).
  assert.equal(Number(res.body.plannedEvent.amount), 1000);
  assert.equal(res.body.plannedEvent.expectedDate, '2026-03-15');

  // It shows up in the forecast as an outflow.
  const forecast = await primaryAgent.get('/api/forecast').query({
    dateFrom: '2026-03-10',
    dateTo: '2026-03-31',
    currency: 'CAD',
    includeRecurring: 'false',
  });
  assert.equal(forecast.status, 200);
  const hasCardOutflow = (forecast.body.events as Array<{ sourceName: string; direction: string }>).some(
    (e) => e.direction === 'out' && /visa|card|payment/i.test(e.sourceName),
  );
  assert.ok(hasCardOutflow, 'expected the card payment to appear in the forecast');
});

test('POST /api/credit-cards/:accountId/payment is idempotent per card (no duplicate events)', async () => {
  await primaryAgent.post(`/api/credit-cards/${cardAccountId}/payment`).send({
    amountStrategy: 'minimum',
    asOfDate: '2026-03-10',
  });
  const events = await primaryAgent.get('/api/planned-events').query({ accountId: cardAccountId });
  const ccEvents = (events.body.data as Array<{ source: string }>).filter(
    (e) => e.source === 'credit_card',
  );
  assert.equal(ccEvents.length, 1, `expected exactly 1 cc payment event, got ${ccEvents.length}`);
});

// AC: user can mark payment as paid or link it to a transaction.
test('POST /api/credit-cards/:accountId/mark-paid posts the event and links a transaction', async () => {
  // Re-create a fresh planned payment to mark paid.
  const created = await primaryAgent.post(`/api/credit-cards/${cardAccountId}/payment`).send({
    amountStrategy: 'statement',
    asOfDate: '2026-03-10',
  });
  const plannedEventId = created.body.plannedEvent.id as number;

  // A real payment transaction lands on the card account.
  const models = await import('../../src/models');
  const fp = `cc-pay-${Date.now()}`;
  const txn = await models.Transaction.create({
    accountId: cardAccountId,
    householdId: primaryHouseholdId,
    date: '2026-03-15',
    amount: '1000',
    currency: 'CAD',
    merchantRaw: 'PAYMENT THANK YOU',
    merchantClean: 'Payment',
    importBatch: 'test',
    sourceRowFingerprint: fp,
    sourceIdentityFingerprint: fp,
  } as never);

  const res = await primaryAgent.post(`/api/credit-cards/${cardAccountId}/mark-paid`).send({
    plannedEventId,
    transactionId: txn.id,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.plannedEvent.status, 'posted');
  assert.equal(res.body.plannedEvent.linkedTransactionId, txn.id);

  // A posted event no longer appears in the forecast (forecast filters status=planned).
  const forecast = await primaryAgent.get('/api/forecast').query({
    dateFrom: '2026-03-10',
    dateTo: '2026-03-31',
    currency: 'CAD',
    includeRecurring: 'false',
  });
  const stillThere = (forecast.body.events as Array<{ sourceId: number; sourceType: string }>).some(
    (e) => e.sourceType === 'planned_event' && e.sourceId === plannedEventId,
  );
  assert.equal(stillThere, false, 'a posted (paid) event should drop out of the forecast');
});

test('credit-card endpoints are household-isolated', async () => {
  // The other household sees only its own card, never the primary's.
  const res = await otherAgent.get('/api/credit-cards');
  assert.equal(res.status, 200);
  const cards = res.body.cards as Array<{ accountId: number }>;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].accountId, otherCardAccountId);
});
