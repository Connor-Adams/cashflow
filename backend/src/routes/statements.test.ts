/**
 * Colocated unit tests for the statement reconciliation math in
 * `routes/statements.ts` (`getReconciliationFor` via GET /api/statements/:id).
 *
 * Runs against the per-process SQLite test DB (see backend/test/setup.ts) —
 * no Postgres needed. The broader CRUD/auth surface is covered by the
 * integration suite (backend/test/integration/statements.test.ts); these
 * tests pin the reconciliation-sum semantics:
 *
 *  - pending transactions are NOT part of a bank statement's closing
 *    balance and must be excluded from expectedClosing;
 *  - reconciliation is an account-level ledger check: the partner's
 *    private rows are real money on the account and must be summed even
 *    when the viewer didn't create them;
 *  - only transactions in the statement's currency are summed (multi-
 *    currency accounts mirror networth/balanceAtDate's per-currency math);
 *  - liability accounts (credit_card/loan/mortgage) reconcile against
 *    bank-convention positive-owed balances: charges stored negative
 *    internally INCREASE the owed closing balance.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import {
  sequelize,
  Account,
  Household,
  HouseholdMember,
  Session,
  Transaction,
  User,
} from '../models';
import { hashPassword, hashToken } from '../auth/password';

process.env.NODE_ENV = 'test';

let app: (typeof import('../app.js'))['default'];
let agent: ReturnType<typeof request.agent>;
let householdId: number;
let viewerId: number;
let partnerId: number;

async function createAccount(opts: {
  name: string;
  accountType: string;
}): Promise<number> {
  const account = await Account.create({
    householdId,
    ownerUserId: viewerId,
    owner: 'me',
    visibility: 'shared',
    name: opts.name,
    accountType: opts.accountType,
    defaultCurrency: 'CAD',
  } as never);
  return account.id;
}

async function createTxn(opts: {
  accountId: number;
  date: string;
  amount: number;
  currency?: string;
  status?: string;
  visibility?: string;
  createdByUserId?: number;
}): Promise<number> {
  const fp = crypto.randomBytes(16).toString('hex');
  const row = await Transaction.create({
    accountId: opts.accountId,
    householdId,
    createdByUserId: opts.createdByUserId ?? viewerId,
    visibility: opts.visibility ?? 'shared',
    importBatch: 'statements-unit-test',
    date: opts.date,
    amount: opts.amount.toFixed(4),
    currency: opts.currency ?? 'CAD',
    status: opts.status ?? 'posted',
    merchantRaw: 'Test Merchant',
    merchantClean: 'Test Merchant',
    sourceRowFingerprint: fp,
    sourceIdentityFingerprint: fp,
    txnType: 'purchase',
    reviewFlag: false,
    finalSplitType: 'me',
  } as never);
  return row.id;
}

async function createStatement(opts: {
  accountId: number;
  periodStart: string;
  periodEnd: string;
  openingBalance: number;
  closingBalance: number;
}): Promise<number> {
  const res = await agent.post('/api/statements').send(opts);
  assert.equal(res.status, 201, `unexpected: ${JSON.stringify(res.body)}`);
  return res.body.data.id as number;
}

before(async () => {
  await sequelize.sync({ force: true });

  const password = await hashPassword('password123');
  const viewer = await User.create({
    email: 'statements-viewer@example.com',
    displayName: 'Viewer',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  } as never);
  const partner = await User.create({
    email: 'statements-partner@example.com',
    displayName: 'Partner',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  } as never);
  viewerId = viewer.id;
  partnerId = partner.id;

  const household = await Household.create({ name: 'Statements Unit HH' } as never);
  householdId = household.id;
  await HouseholdMember.create({
    householdId,
    userId: viewer.id,
    role: 'owner',
  } as never);
  await HouseholdMember.create({
    householdId,
    userId: partner.id,
    role: 'member',
  } as never);

  const token = crypto.randomBytes(32).toString('hex');
  await Session.create({
    userId: viewer.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
  } as never);

  const mod = await import('../app.js');
  app = mod.default;
  agent = request.agent(app);
  agent.jar.setCookie(`cashflow_session=${token}; Path=/`);
});

test('pending transactions are excluded from expectedClosing', async () => {
  const accountId = await createAccount({
    name: 'Pending Exclusion',
    accountType: 'checking',
  });
  await createTxn({ accountId, date: '2026-01-10', amount: -100 });
  await createTxn({
    accountId,
    date: '2026-01-15',
    amount: -50,
    status: 'pending',
  });
  // Bank statement only reflects posted activity: 1000 - 100 = 900.
  const id = await createStatement({
    accountId,
    periodStart: '2026-01-01',
    periodEnd: '2026-01-31',
    openingBalance: 1000,
    closingBalance: 900,
  });
  const detail = await agent.get(`/api/statements/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.reconciliation.expectedClosing, 900);
  assert.equal(detail.body.reconciliation.variance, 0);
  assert.equal(detail.body.reconciliation.isBalanced, true);
  assert.equal(detail.body.reconciliation.transactionCount, 1);
  const statuses = (detail.body.transactions as Array<{ status: string }>).map(
    (t) => t.status,
  );
  assert.ok(!statuses.includes('pending'), 'pending row must not be listed');
});

test("partner's private transactions are included in the account-level sum", async () => {
  const accountId = await createAccount({
    name: 'Partner Private Inclusion',
    accountType: 'checking',
  });
  // Created by the OTHER household member with default 'private' visibility —
  // still real money on the account, included in the bank's closing balance.
  await createTxn({
    accountId,
    date: '2026-02-10',
    amount: -200,
    visibility: 'private',
    createdByUserId: partnerId,
  });
  const id = await createStatement({
    accountId,
    periodStart: '2026-02-01',
    periodEnd: '2026-02-28',
    openingBalance: 1000,
    closingBalance: 800,
  });
  const detail = await agent.get(`/api/statements/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.reconciliation.expectedClosing, 800);
  assert.equal(detail.body.reconciliation.variance, 0);
  assert.equal(detail.body.reconciliation.transactionCount, 1);
});

test('only transactions in the statement currency are summed', async () => {
  const accountId = await createAccount({
    name: 'Currency Isolation',
    accountType: 'checking',
  });
  await createTxn({ accountId, date: '2026-03-10', amount: -100, currency: 'CAD' });
  await createTxn({ accountId, date: '2026-03-12', amount: -75, currency: 'USD' });
  // Statement defaults to the account currency (CAD): 500 - 100 = 400.
  const id = await createStatement({
    accountId,
    periodStart: '2026-03-01',
    periodEnd: '2026-03-31',
    openingBalance: 500,
    closingBalance: 400,
  });
  const detail = await agent.get(`/api/statements/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.reconciliation.expectedClosing, 400);
  assert.equal(detail.body.reconciliation.variance, 0);
  assert.equal(detail.body.reconciliation.transactionCount, 1);
});

test('liability accounts reconcile bank-style positive-owed balances', async () => {
  const accountId = await createAccount({
    name: 'Credit Card Sign',
    accountType: 'credit_card',
  });
  // Internally charges are stored negative and payments positive
  // (csvProfiles invert_sign); the printed statement reports positive
  // amounts owed: opening 500 owed + 1000 charges - 300 payment = 1200 owed.
  await createTxn({ accountId, date: '2026-04-05', amount: -1000 });
  await createTxn({ accountId, date: '2026-04-20', amount: 300 });
  const id = await createStatement({
    accountId,
    periodStart: '2026-04-01',
    periodEnd: '2026-04-30',
    openingBalance: 500,
    closingBalance: 1200,
  });
  const detail = await agent.get(`/api/statements/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.reconciliation.expectedClosing, 1200);
  assert.equal(detail.body.reconciliation.variance, 0);
  assert.equal(detail.body.reconciliation.isBalanced, true);
});

test('list pagination falls back to defaults on non-numeric page/pageSize', async () => {
  // parseInt('abc') is NaN and Math.max(1, NaN) is NaN — without a finite
  // guard, NaN limit/offset reach Sequelize's query generator.
  const res = await agent.get('/api/statements?page=abc&pageSize=xyz');
  assert.equal(res.status, 200, `unexpected: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.page, 1);
  assert.equal(res.body.pageSize, 50);
});

test('asset accounts keep the plain opening + sum convention', async () => {
  const accountId = await createAccount({
    name: 'Asset Convention',
    accountType: 'savings',
  });
  await createTxn({ accountId, date: '2026-05-10', amount: -150 });
  await createTxn({ accountId, date: '2026-05-12', amount: 50 });
  const id = await createStatement({
    accountId,
    periodStart: '2026-05-01',
    periodEnd: '2026-05-31',
    openingBalance: 1000,
    closingBalance: 900,
  });
  const detail = await agent.get(`/api/statements/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.reconciliation.expectedClosing, 900);
  assert.equal(detail.body.reconciliation.variance, 0);
});
