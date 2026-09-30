/**
 * `GET /api/budgets/{progress,status}` under a SUPERADMIN caller.
 *
 * `householdWhere(req)` (backend/src/auth/scope.ts) deliberately returns `{}`
 * for a superadmin so cross-household listings work. Forwarding that into a
 * budget's spend aggregate is a category error: the aggregate is compared
 * against ONE household's target, so an unscoped sum makes `spent`, `remaining`,
 * `percentUsed` and `pacingState` meaningless — and `percentUsed` reads wildly
 * over 100, which is the same vocabulary the breach thresholds use.
 *
 * Two invariants are locked here:
 *
 *   1. Spend is scoped by the budget's own `householdId` regardless of caller
 *      role, matching `processBudget` in `budgets/budgetBreachCheck.ts`.
 *   2. `/progress` and `/status` list the CALLER's household budgets only. They
 *      are single-household views (target vs. spend vs. pacing); a
 *      cross-household mix has no coherent reading. `GET /api/budgets` — a
 *      plain row listing with no aggregate — stays cross-household for a
 *      superadmin, and that asymmetry is asserted below so it stays deliberate.
 *
 * Runs at UNIT level (per-PID SQLite via test/setup.ts, no Postgres): seed the
 * rows directly, boot the exported app, drive it with supertest.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import {
  sequelize,
  Account,
  BudgetTarget,
  Household,
  HouseholdMember,
  Session,
  Transaction,
  User,
} from '../models';
import { hashPassword, hashToken } from '../auth/password';

const CURRENCY = 'CAD';
const CATEGORY = 'Dining';

/** Today, local — the routes use the wall clock, so seed inside this period. */
const today = new Date();
const TODAY = [
  today.getFullYear(),
  String(today.getMonth() + 1).padStart(2, '0'),
  String(today.getDate()).padStart(2, '0'),
].join('-');

let app: Express;
let sessionToken: string;
let ownHouseholdId: number;
let ownBudgetId: number;
let otherBudgetId: number;

async function seedHousehold(name: string): Promise<{
  householdId: number;
  accountId: number;
}> {
  const hh = await Household.create({ name } as never);
  const account = await Account.create({
    householdId: hh.id,
    ownerUserId: null,
    owner: 'me',
    visibility: 'shared',
    name: `${name} card`,
    accountType: 'credit',
    defaultCurrency: CURRENCY,
    shortCode: name.slice(0, 3).toUpperCase(),
  } as never);
  return { householdId: hh.id, accountId: account.id };
}

async function seedSpend(
  where: { householdId: number; accountId: number },
  amount: number,
): Promise<void> {
  await Transaction.create({
    accountId: where.accountId,
    householdId: where.householdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'superadmin-scope-test',
    date: TODAY,
    merchantRaw: 'Somewhere',
    merchantClean: 'Somewhere',
    amount: amount.toFixed(4),
    currency: CURRENCY,
    txnType: 'purchase',
    linkedTransactionId: null,
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: CATEGORY,
    autoBusiness: null,
    businessOverride: null,
  } as never);
}

before(async () => {
  process.env.NODE_ENV = 'test';
  await sequelize.sync({ force: true });

  const own = await seedHousehold('Superadmin HH');
  const other = await seedHousehold('Stranger HH');
  ownHouseholdId = own.householdId;

  // $100 here, $900 somewhere the caller has no business aggregating.
  await seedSpend(own, -100);
  await seedSpend(other, -900);

  ownBudgetId = (
    await BudgetTarget.create({
      householdId: own.householdId,
      category: CATEGORY,
      currency: CURRENCY,
      amount: '1000.0000',
      period: 'monthly',
      scope: 'household',
    } as never)
  ).id;
  otherBudgetId = (
    await BudgetTarget.create({
      householdId: other.householdId,
      category: CATEGORY,
      currency: CURRENCY,
      amount: '500.0000',
      period: 'monthly',
      scope: 'household',
    } as never)
  ).id;

  const password = await hashPassword('password123');
  const user = await User.create({
    email: `budget-superadmin-${Date.now()}@example.com`,
    displayName: 'Budget Superadmin',
    globalRole: 'superadmin',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  } as never);
  await HouseholdMember.create({
    householdId: own.householdId,
    userId: user.id,
    role: 'owner',
  } as never);

  sessionToken = crypto.randomBytes(32).toString('hex');
  await Session.create({
    userId: user.id,
    tokenHash: hashToken(sessionToken),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
  } as never);

  // Import the app only AFTER the schema + session exist so attachAuth can
  // resolve the session cookie on the very first request.
  app = (await import('../app.js')).default;
});

const authCookie = () => `cashflow_session=${sessionToken}`;

for (const path of ['/api/budgets/progress', '/api/budgets/status']) {
  test(`${path}: a superadmin sees only their own household budgets`, async () => {
    const res = await request(app).get(path).set('Cookie', authCookie());
    assert.equal(res.status, 200);
    const ids = (res.body.items as Array<{ budgetId: number }>).map(
      (i) => i.budgetId,
    );
    assert.deepEqual(ids, [ownBudgetId]);
  });

  test(`${path}: spend counts only the budget own household`, async () => {
    const res = await request(app).get(path).set('Cookie', authCookie());
    assert.equal(res.status, 200);
    const [item] = res.body.items as Array<{
      spent: number;
      remaining: number;
      percentUsed: number;
      pacingState: string;
    }>;
    assert.ok(item, 'expected one budget status item');
    // The stranger household's $900 must not appear. Unscoped this reads
    // $1000 spent / 100% used, which is also a breach-threshold reading.
    assert.equal(item.spent, 100);
    assert.equal(item.remaining, 900);
    assert.equal(item.percentUsed, 10);
    assert.notEqual(item.pacingState, 'over');
  });
}

test('GET /api/budgets: the plain listing stays cross-household for a superadmin', async () => {
  // Asymmetric with /progress and /status ON PURPOSE — this route returns rows,
  // not aggregates, so a superadmin auditing every household is coherent here.
  const res = await request(app).get('/api/budgets').set('Cookie', authCookie());
  assert.equal(res.status, 200);
  const ids = (res.body.data as Array<{ id: number }>).map((i) => i.id).sort();
  assert.deepEqual(ids, [ownBudgetId, otherBudgetId].sort());
});

test('the two households really are distinct (fixture guard)', async () => {
  const row = await BudgetTarget.findByPk(otherBudgetId);
  assert.ok(row);
  assert.notEqual(row.householdId, ownHouseholdId);
});
