/**
 * Integration tests for the daily budget-breach cron (issue #268).
 *
 * Runs against a real Postgres test DB so the new JSON column and the
 * `budget_alert_states` UNIQUE constraint exercise the production dialect
 * (sqlite is too forgiving for both).
 *
 * Each test is self-contained: it seeds the data it depends on and uses
 * unique categories so other tests don't bleed in. After each test we
 * truncate `notifications` + `budget_alert_states` so the next test starts
 * clean.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let primaryAgent: ReturnType<typeof request.agent>;
let primaryHouseholdId: number;
let primaryAccountId: number;
let primaryUserId: number;
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
  const household = await models.Household.create({
    name: `${emailPrefix} household`,
  });
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
  return {
    token,
    householdId: household.id,
    userId: user.id,
    accountId: account.id,
  };
}

/**
 * Push a spend row into the same household. Charges arrive negative so the
 * `aggregateSpendByCategory` helper (which sums `-amount` when `amount<0`)
 * counts them as gross outflow against the budget target.
 */
async function spend(
  householdId: number,
  accountId: number,
  dateIso: string,
  category: string | null,
  amount: number,
  currency = 'CAD',
): Promise<number> {
  const models = await import('../../src/models');
  const row = await models.Transaction.create({
    accountId,
    householdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'budget-breach-test',
    date: dateIso,
    merchantRaw: 'Test Merchant',
    merchantClean: 'Test Merchant',
    amount: amount.toFixed(4),
    currency,
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
    autoPctMe: null,
    pctMeOverride: null,
    finalPctMe: null,
    autoPctPartner: null,
    pctPartnerOverride: null,
    finalPctPartner: null,
    reviewFlag: false,
    reviewedAt: null,
    // Sole worker is also the recipient; the cron-owned spend rows belong
    // to the same user so visibleTransactionWhere for regular users still
    // resolves to this household's rows.
    createdByUserId: primaryUserId,
  });
  return row.id;
}

async function createBudget(opts: {
  category: string | null;
  amount: number;
  alertThresholds?: number[];
}): Promise<number> {
  const res = await primaryAgent.post('/api/budgets').send({
    category: opts.category,
    currency: 'CAD',
    amount: opts.amount,
    alertThresholds: opts.alertThresholds,
  });
  assert.equal(res.status, 201, `budget create failed: ${res.text}`);
  return res.body.id as number;
}

function currentMonthDate(dayOfMonth: number): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(dayOfMonth).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

before(async () => {
  testDb = await setupPgTestDb('budgetBreachCheck');
  const mod = await import('../../src/app.js');
  app = mod.default;

  const bootstrap = testAgent(app);
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
  primaryAgent = testAgent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);
});

beforeEach(async () => {
  // Wipe everything the cron writes / observes so each test runs on a
  // clean slate without changing the seeded household / account.
  const models = await import('../../src/models');
  await models.BudgetAlertState.destroy({ where: {}, truncate: true });
  await models.Notification.destroy({ where: {}, truncate: true });
  await models.NotificationPreference.destroy({ where: {}, truncate: true });
  await models.BudgetTarget.destroy({ where: {} });
  await models.Transaction.destroy({ where: {} });
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// ---- AC #1: column + table created with the right defaults ---------------

test('GET /api/budgets returns alertThresholds with default [80,100,120]', async () => {
  await createBudget({ category: 'Groceries', amount: 400 });
  const res = await primaryAgent.get('/api/budgets');
  assert.equal(res.status, 200);
  const rows = res.body.data as Array<{ alertThresholds: number[] }>;
  assert.deepEqual(rows[0].alertThresholds, [80, 100, 120]);
});

// ---- AC #7: PATCH /:id accepts + validates alertThresholds ----------------

test('PATCH /api/budgets/:id accepts custom alertThresholds', async () => {
  const id = await createBudget({ category: 'Coffee', amount: 100 });
  const res = await primaryAgent
    .patch(`/api/budgets/${id}`)
    .send({ alertThresholds: [80, 100] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.alertThresholds, [80, 100]);
});

test('PATCH /api/budgets/:id rejects invalid threshold (zero)', async () => {
  const id = await createBudget({ category: 'Dining', amount: 200 });
  const res = await primaryAgent
    .patch(`/api/budgets/${id}`)
    .send({ alertThresholds: [0, 100] });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /integers between 1 and 500/);
});

test('PATCH /api/budgets/:id rejects invalid threshold (>500)', async () => {
  const id = await createBudget({ category: 'Misc', amount: 50 });
  const res = await primaryAgent
    .patch(`/api/budgets/${id}`)
    .send({ alertThresholds: [80, 600] });
  assert.equal(res.status, 400);
});

test('PATCH /api/budgets/:id dedupes + sorts alertThresholds', async () => {
  const id = await createBudget({ category: 'Subs', amount: 50 });
  const res = await primaryAgent
    .patch(`/api/budgets/${id}`)
    .send({ alertThresholds: [100, 80, 100, 120] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.alertThresholds, [80, 100, 120]);
});

// ---- AC #3, #4, #5: cron enqueues + writes state, idempotent on rerun -----

test('cron fires the 80 threshold when spend crosses 80% (AC #3, #4)', async () => {
  await createBudget({ category: 'Travel', amount: 100 });
  // 85% spent
  await spend(primaryHouseholdId, primaryAccountId, currentMonthDate(15), 'Travel', -85);

  const { runBudgetBreachCheck } = await import(
    '../../src/budgets/budgetBreachCheck.js'
  );
  const summary = await runBudgetBreachCheck();
  assert.equal(summary.notificationsSent, 1);
  assert.equal(summary.budgetsAlerted, 1);
  assert.equal(summary.errors, 0);

  const list = await primaryAgent.get('/api/notifications');
  assert.equal(list.status, 200);
  const rows = list.body.data as Array<{
    type: string;
    title: string;
    body: string;
    dataJson: Record<string, unknown>;
  }>;
  const breachRow = rows.find((r) => r.type === 'budget.breach');
  assert.ok(breachRow, 'expected a budget.breach notification row');
  assert.match(breachRow!.title, /80%.*Travel/i);
  assert.match(breachRow!.body, /\$85\.00 of \$100\.00 this month/);
  // AC #11: body has spent, target, period, days-left.
  assert.match(breachRow!.body, /days left|day left|Period ends today/);
  // dataJson surfaces the structured payload for the bell to drill into.
  assert.equal(breachRow!.dataJson.threshold, 80);
  assert.equal(breachRow!.dataJson.category, 'Travel');
});

test('rerun the cron in the same period does NOT duplicate notifications (AC #5)', async () => {
  await createBudget({ category: 'Dining', amount: 200 });
  await spend(primaryHouseholdId, primaryAccountId, currentMonthDate(15), 'Dining', -170);

  const { runBudgetBreachCheck } = await import(
    '../../src/budgets/budgetBreachCheck.js'
  );
  // First run: 85% > 80 → expect one notification.
  const first = await runBudgetBreachCheck();
  assert.equal(first.notificationsSent, 1);

  // Second run: NO new spend, same period → expect zero new notifications.
  const second = await runBudgetBreachCheck();
  assert.equal(second.notificationsSent, 0);

  const list = await primaryAgent.get('/api/notifications');
  const breaches = (list.body.data as Array<{ type: string }>).filter(
    (r) => r.type === 'budget.breach',
  );
  assert.equal(breaches.length, 1, 'exactly one breach row should exist');
});

test('after crossing 80% then 100%, a second run alerts the 100 threshold only', async () => {
  await createBudget({ category: 'Subscriptions', amount: 50 });
  // First wave: 90% spent → only 80 fires.
  await spend(
    primaryHouseholdId,
    primaryAccountId,
    currentMonthDate(10),
    'Subscriptions',
    -45,
  );
  const { runBudgetBreachCheck } = await import(
    '../../src/budgets/budgetBreachCheck.js'
  );
  const firstSummary = await runBudgetBreachCheck();
  assert.equal(firstSummary.notificationsSent, 1);

  // More spend pushes to 110%.
  await spend(
    primaryHouseholdId,
    primaryAccountId,
    currentMonthDate(20),
    'Subscriptions',
    -10,
  );
  const secondSummary = await runBudgetBreachCheck();
  assert.equal(secondSummary.notificationsSent, 1);

  // We should now have two breach rows total: one for 80, one for 100.
  const list = await primaryAgent.get('/api/notifications');
  const breaches = (
    list.body.data as Array<{
      type: string;
      dataJson: { threshold: number };
    }>
  )
    .filter((r) => r.type === 'budget.breach')
    .map((r) => r.dataJson.threshold)
    .sort((a, b) => a - b);
  assert.deepEqual(breaches, [80, 100]);
});

// ---- AC #6: per-budget errors don't tank the rest ------------------------

test('a budget below threshold is silently skipped without errors (AC #3, AC #6)', async () => {
  await createBudget({ category: 'Pet', amount: 200 });
  // 50% spent — under every threshold.
  await spend(primaryHouseholdId, primaryAccountId, currentMonthDate(15), 'Pet', -100);

  const { runBudgetBreachCheck } = await import(
    '../../src/budgets/budgetBreachCheck.js'
  );
  const summary = await runBudgetBreachCheck();
  assert.equal(summary.notificationsSent, 0);
  assert.equal(summary.budgetsAlerted, 0);
  assert.equal(summary.errors, 0);
});

// ---- AC #4: alert payload includes threshold, spent, target, periodKey ----

test('notification dataJson carries the structured budget context (AC #4)', async () => {
  const id = await createBudget({
    category: 'Books',
    amount: 50,
    alertThresholds: [80],
  });
  await spend(primaryHouseholdId, primaryAccountId, currentMonthDate(15), 'Books', -50);

  const { runBudgetBreachCheck } = await import(
    '../../src/budgets/budgetBreachCheck.js'
  );
  await runBudgetBreachCheck();

  const list = await primaryAgent.get('/api/notifications');
  const breach = (
    list.body.data as Array<{
      type: string;
      dataJson: {
        budgetId: number;
        threshold: number;
        spent: number;
        target: number;
        periodKey: string;
        category: string;
      };
    }>
  ).find((r) => r.type === 'budget.breach');
  assert.ok(breach);
  assert.equal(breach!.dataJson.budgetId, id);
  assert.equal(breach!.dataJson.threshold, 80);
  assert.equal(breach!.dataJson.spent, 50);
  assert.equal(breach!.dataJson.target, 50);
  assert.equal(breach!.dataJson.category, 'Books');
  const now = new Date();
  const expectedKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  assert.equal(breach!.dataJson.periodKey, expectedKey);
});

// ---- AC #8/Settings respect: per-budget thresholds gate which alerts fire -

test('custom alertThresholds gate which thresholds fire', async () => {
  // User only wants the 100% alert — no early warning.
  await createBudget({
    category: 'Gifts',
    amount: 100,
    alertThresholds: [100],
  });
  // 85% spent — the default 80 would fire, but with [100] it should not.
  await spend(primaryHouseholdId, primaryAccountId, currentMonthDate(15), 'Gifts', -85);

  const { runBudgetBreachCheck } = await import(
    '../../src/budgets/budgetBreachCheck.js'
  );
  const summary = await runBudgetBreachCheck();
  assert.equal(summary.notificationsSent, 0);
});

test('empty alertThresholds disables alerts entirely', async () => {
  await createBudget({
    category: 'Hobbies',
    amount: 100,
    alertThresholds: [],
  });
  await spend(primaryHouseholdId, primaryAccountId, currentMonthDate(15), 'Hobbies', -200);

  const { runBudgetBreachCheck } = await import(
    '../../src/budgets/budgetBreachCheck.js'
  );
  const summary = await runBudgetBreachCheck();
  assert.equal(summary.notificationsSent, 0);
});

// ---- AC #2: mute via notification preference is respected ----------------

test('muted budget.breach preference suppresses the in-app row', async () => {
  await createBudget({ category: 'Lunch', amount: 100 });
  await spend(primaryHouseholdId, primaryAccountId, currentMonthDate(15), 'Lunch', -85);

  // Mute the channel before running the cron. Preferences moved under the
  // user namespace in issue #379.
  const muteRes = await primaryAgent
    .patch('/api/users/me/notifications/preferences/budget.breach')
    .send({ channelInApp: false });
  assert.equal(muteRes.status, 200);

  const { runBudgetBreachCheck } = await import(
    '../../src/budgets/budgetBreachCheck.js'
  );
  await runBudgetBreachCheck();

  // No in-app row was created.
  const list = await primaryAgent.get('/api/notifications');
  const breaches = (list.body.data as Array<{ type: string }>).filter(
    (r) => r.type === 'budget.breach',
  );
  assert.equal(breaches.length, 0);

  // But the alert-state row IS persisted, so a future run doesn't try
  // again for the same threshold. (Failing to write the state row would
  // produce a thrash: cron runs, gets muted, leaves nothing → next run
  // tries to enqueue again, which only matters once the user unmutes.)
  const models = await import('../../src/models');
  const stateCount = await models.BudgetAlertState.count({
    where: { userId: primaryUserId },
  });
  assert.ok(stateCount >= 1, `expected at least one state row, got ${stateCount}`);
});

// ---- AC #12: deleting a budget cascades to its alert states --------------

test('deleting a budget cascades to delete its alert-state rows', async () => {
  const id = await createBudget({ category: 'TravelCascade', amount: 100 });
  await spend(
    primaryHouseholdId,
    primaryAccountId,
    currentMonthDate(15),
    'TravelCascade',
    -85,
  );
  const { runBudgetBreachCheck } = await import(
    '../../src/budgets/budgetBreachCheck.js'
  );
  await runBudgetBreachCheck();

  const models = await import('../../src/models');
  const beforeCount = await models.BudgetAlertState.count({
    where: { budgetTargetId: id },
  });
  assert.ok(beforeCount >= 1);

  const del = await primaryAgent.delete(`/api/budgets/${id}`);
  assert.equal(del.status, 204);

  const afterCount = await models.BudgetAlertState.count({
    where: { budgetTargetId: id },
  });
  assert.equal(afterCount, 0, 'cascade delete should remove alert states');
});
