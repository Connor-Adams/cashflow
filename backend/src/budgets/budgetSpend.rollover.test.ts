/**
 * End-to-end period accumulation for `rolloverEnabled` budgets: seeds real
 * transactions across several monthly periods and asserts what
 * `loadBudgetSpend` carries forward.
 *
 * These are the tests that actually pin the feature. The pure-math cases live in
 * `budgetSpend.test.ts` (`priorPeriodAllowance`) and `routes/budgets.test.ts`
 * (`computeBudgetProgress` carry branches); this file exercises the wiring
 * between them — the widened query window, the prior/current row partition, the
 * carry subtraction and the rollover-off path.
 *
 * `now` is injected everywhere, so nothing here depends on the wall clock.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { sequelize } from '../db';
import * as models from '../models';
import { loadBudgetSpend, toBudgetSpendInput } from './budgetSpend';
import { loadCategoryTree } from '../categories/rollup';

const CURRENCY = 'CAD';
const CATEGORY = 'Dining';
/** Mid-April 2026. The current period is 2026-04-01..2026-04-30 throughout. */
const NOW = new Date(2026, 3, 15, 12, 0, 0);

let householdId: number;
let accountId: number;

beforeEach(async () => {
  await sequelize.sync({ force: true });
  const hh = await models.Household.create({ name: 'Rollover' });
  const account = await models.Account.create({
    householdId: hh.id,
    ownerUserId: null,
    owner: 'me',
    visibility: 'shared',
    name: 'Rollover card',
    accountType: 'credit',
    defaultCurrency: CURRENCY,
    shortCode: 'ROL',
  });
  householdId = hh.id;
  accountId = account.id;
});

async function spend(
  date: string,
  amount: number,
  opts: { category?: string | null; txnType?: string; linkedTransactionId?: number } = {},
): Promise<number> {
  const row = await models.Transaction.create({
    accountId,
    householdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'rollover-test',
    date,
    merchantRaw: 'Somewhere',
    merchantClean: 'Somewhere',
    amount: amount.toFixed(4),
    currency: CURRENCY,
    txnType: opts.txnType ?? 'purchase',
    linkedTransactionId: opts.linkedTransactionId ?? null,
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: opts.category === undefined ? CATEGORY : opts.category,
    autoBusiness: null,
    businessOverride: null,
  });
  return row.id;
}

async function makeBudget(opts: {
  amount: number;
  rolloverEnabled: boolean;
  createdAt: Date;
  category?: string | null;
  excludeRefundedPurchases?: boolean;
}) {
  const row = await models.BudgetTarget.create({
    householdId,
    category: opts.category === undefined ? CATEGORY : opts.category,
    currency: CURRENCY,
    amount: opts.amount.toFixed(4),
    period: 'monthly',
    scope: 'household',
    rolloverEnabled: opts.rolloverEnabled,
    excludeRefundedPurchases: opts.excludeRefundedPurchases ?? false,
  });
  // `createdAt` is managed by Sequelize, so backdate it explicitly — the carry
  // window is anchored on it.
  await models.BudgetTarget.update(
    { createdAt: opts.createdAt },
    { where: { id: row.id }, silent: true, fields: ['createdAt'] },
  );
  const reloaded = await models.BudgetTarget.findByPk(row.id);
  assert.ok(reloaded);
  return reloaded;
}

async function load(budget: Awaited<ReturnType<typeof makeBudget>>) {
  const tree = await loadCategoryTree(householdId);
  return loadBudgetSpend({
    budget: toBudgetSpendInput(budget),
    householdWhere: { householdId },
    tree,
    now: NOW,
  });
}

// ---- first period (no prior) ------------------------------------------------

test('rollover: a budget created in the current period carries nothing', async () => {
  const budget = await makeBudget({
    amount: 1000,
    rolloverEnabled: true,
    createdAt: new Date(2026, 3, 2),
  });
  await spend('2026-04-10', -300);

  const { progress, priorPeriodCount, anchorStart, bounds } = await load(budget);
  assert.equal(priorPeriodCount, 0);
  // The query must not widen when there is nothing to reach back for.
  assert.equal(anchorStart, bounds.periodStart);
  assert.equal(anchorStart, '2026-04-01');
  assert.equal(progress.carriedIn, 0);
  assert.equal(progress.baseTarget, 1000);
  assert.equal(progress.target, 1000);
  assert.equal(progress.spent, 300);
  assert.equal(progress.percentUsed, 30);
});

test('rollover: prior-period spend is excluded from the current period even when the window widens', async () => {
  const budget = await makeBudget({
    amount: 1000,
    rolloverEnabled: true,
    createdAt: new Date(2026, 2, 1),
  });
  await spend('2026-03-20', -400); // March: prior
  await spend('2026-04-05', -100); // April: current

  const { progress } = await load(budget);
  // The widened query pulls March's row in; it must feed the carry, never
  // `spent`. A regression here would double-count history as current spend.
  assert.equal(progress.spent, 100);
  assert.equal(progress.carriedIn, 600); // 1000 allowance - 400 spent
});

// ---- positive carry ---------------------------------------------------------

test('rollover: one under-spent prior month raises the effective target', async () => {
  const budget = await makeBudget({
    amount: 1000,
    rolloverEnabled: true,
    createdAt: new Date(2026, 2, 1), // March 1 — a whole prior period
  });
  await spend('2026-03-10', -600);
  await spend('2026-04-08', -900);

  const { progress, priorPeriodCount } = await load(budget);
  assert.equal(priorPeriodCount, 1);
  assert.equal(progress.carriedIn, 400);
  assert.equal(progress.target, 1400);
  assert.equal(progress.spent, 900);
  assert.equal(progress.remaining, 500);
  assert.equal(progress.percentUsed, (900 / 1400) * 100);
  // $900 against a $1000 base would be 90% and nearly breaching; with the carry
  // it is comfortably funded. This is the whole point of the feature.
  assert.ok(progress.percentUsed < 90);
});

test('rollover: surplus compounds across three prior months', async () => {
  const budget = await makeBudget({
    amount: 1000,
    rolloverEnabled: true,
    createdAt: new Date(2026, 0, 1), // Jan 1
  });
  await spend('2026-01-15', -700); // +300
  await spend('2026-02-15', -800); // +200
  await spend('2026-03-15', -500); // +500
  await spend('2026-04-02', -250);

  const { progress, priorPeriodCount, anchorStart } = await load(budget);
  assert.equal(priorPeriodCount, 3);
  assert.equal(anchorStart, '2026-01-01');
  assert.equal(progress.carriedIn, 1000); // 3000 allowance - 2000 spent
  assert.equal(progress.target, 2000);
  assert.equal(progress.spent, 250);
});

// ---- negative carry (unclamped) --------------------------------------------

test('rollover: an overspent prior month carries the debt forward as a reduction', async () => {
  const budget = await makeBudget({
    amount: 1000,
    rolloverEnabled: true,
    createdAt: new Date(2026, 2, 1),
  });
  await spend('2026-03-10', -1500); // overspent by 500
  await spend('2026-04-08', -200);

  const { progress } = await load(budget);
  assert.equal(progress.carriedIn, -500);
  assert.equal(progress.target, 500);
  assert.equal(progress.spent, 200);
  assert.equal(progress.remaining, 300);
  assert.equal(progress.percentUsed, 40);
});

test('rollover: debt is NOT floored at zero — it compounds across periods', async () => {
  const budget = await makeBudget({
    amount: 1000,
    rolloverEnabled: true,
    createdAt: new Date(2026, 1, 1), // Feb 1
  });
  await spend('2026-02-10', -1400); // -400
  await spend('2026-03-10', -1300); // -300, cumulative -700

  const { progress, priorPeriodCount } = await load(budget);
  assert.equal(priorPeriodCount, 2);
  // 2000 allowance - 2700 spent. A floor-at-zero design would report -300 here
  // (February forgiven); unclamped propagation is the chosen semantics.
  assert.equal(progress.carriedIn, -700);
  assert.equal(progress.target, 300);
});

test('rollover: debt exceeding a full allowance drives the effective target negative', async () => {
  const budget = await makeBudget({
    amount: 1000,
    rolloverEnabled: true,
    createdAt: new Date(2026, 2, 1),
  });
  await spend('2026-03-10', -2500); // -1500 carry
  await spend('2026-04-08', -300);

  const { progress } = await load(budget);
  assert.equal(progress.carriedIn, -1500);
  assert.equal(progress.target, -500);
  // `spent / effectiveTarget` is meaningless at a non-positive target, so the
  // defined branch applies: 100% for being underwater plus 30% of one base
  // allowance spent on top.
  assert.equal(progress.percentUsed, 130);
  assert.equal(progress.remaining, -800);
});

// ---- rollover disabled ------------------------------------------------------

test('rollover disabled: prior periods are neither queried nor carried', async () => {
  const budget = await makeBudget({
    amount: 1000,
    rolloverEnabled: false,
    createdAt: new Date(2026, 0, 1),
  });
  await spend('2026-03-10', -600);
  await spend('2026-04-08', -250);

  const { progress, priorPeriodCount, anchorStart, bounds } = await load(budget);
  assert.equal(priorPeriodCount, 0);
  assert.equal(anchorStart, bounds.periodStart);
  assert.equal(progress.carriedIn, 0);
  assert.equal(progress.target, 1000);
  assert.equal(progress.baseTarget, 1000);
  assert.equal(progress.spent, 250);
  assert.equal(progress.percentUsed, 25);
});

test('rollover disabled vs enabled differ ONLY by the carry', async () => {
  // Same transactions, two budgets. Guards against the widened window changing
  // current-period spend as a side effect.
  await spend('2026-03-10', -600);
  await spend('2026-04-08', -250);
  const off = await makeBudget({
    amount: 1000,
    rolloverEnabled: false,
    createdAt: new Date(2026, 2, 1),
  });
  const on = await makeBudget({
    amount: 1000,
    rolloverEnabled: true,
    createdAt: new Date(2026, 2, 1),
  });

  const offResult = await load(off);
  const onResult = await load(on);
  assert.equal(offResult.progress.spent, onResult.progress.spent);
  assert.equal(offResult.progress.baseTarget, onResult.progress.baseTarget);
  assert.equal(offResult.progress.carriedIn, 0);
  assert.equal(onResult.progress.carriedIn, 400);
});

// ---- interaction with the rest of the pipeline -----------------------------

test('rollover: the creation period is prorated, so a late-created budget does not bank a full month', async () => {
  const budget = await makeBudget({
    amount: 3100, // $100/day across a 31-day March
    rolloverEnabled: true,
    createdAt: new Date(2026, 2, 22), // Mar 22 → 10 of March's 31 days
  });
  await spend('2026-03-25', -400);

  const { progress } = await load(budget);
  // Allowance for March is 3100 * 10/31 = 1000, not 3100.
  assert.ok(
    Math.abs(progress.carriedIn - 600) < 1e-6,
    `expected ~600, got ${progress.carriedIn}`,
  );
});

test('rollover: spend outside the budget category never feeds the carry', async () => {
  const budget = await makeBudget({
    amount: 1000,
    rolloverEnabled: true,
    createdAt: new Date(2026, 2, 1),
  });
  await spend('2026-03-10', -900, { category: 'Rent' });
  await spend('2026-03-11', -100);

  const { progress } = await load(budget);
  // Only the $100 of Dining counts, so the full carry is 1000 - 100.
  assert.equal(progress.carriedIn, 900);
});

test('rollover: an excluded transaction is excluded from the carry too', async () => {
  const budget = await makeBudget({
    amount: 1000,
    rolloverEnabled: true,
    createdAt: new Date(2026, 2, 1),
  });
  const ignored = await spend('2026-03-10', -400);
  await spend('2026-03-11', -100);
  await models.BudgetExclusion.create({
    budgetId: budget.id,
    transactionId: ignored,
  });

  const { progress } = await load(budget);
  assert.equal(progress.carriedIn, 900); // the $400 exclusion never counted
});

test('rollover: a refund nets out of the period its ORIGINAL purchase landed in', async () => {
  const budget = await makeBudget({
    amount: 1000,
    rolloverEnabled: true,
    createdAt: new Date(2026, 2, 1),
    excludeRefundedPurchases: true,
  });
  const marchPurchase = await spend('2026-03-10', -700);
  // The refund is dated in APRIL but reverses a MARCH purchase. It must lift
  // March's carry, not reduce April's spend — otherwise refunds would migrate
  // spend between periods.
  await spend('2026-04-05', 200, {
    txnType: 'refund',
    linkedTransactionId: marchPurchase,
  });
  await spend('2026-04-09', -150);

  const { progress } = await load(budget);
  assert.equal(progress.spent, 150);
  assert.equal(progress.carriedIn, 500); // 1000 - (700 - 200)
});

test('rollover: an overall (category=null) budget carries total spend in its currency', async () => {
  const budget = await makeBudget({
    amount: 2000,
    rolloverEnabled: true,
    createdAt: new Date(2026, 2, 1),
    category: null,
  });
  await spend('2026-03-10', -500, { category: 'Rent' });
  await spend('2026-03-11', -300);
  await spend('2026-04-04', -200, { category: 'Rent' });

  const { progress } = await load(budget);
  assert.equal(progress.carriedIn, 1200); // 2000 - 800
  assert.equal(progress.spent, 200);
  assert.equal(progress.target, 3200);
});

test('rollover: the lookback cap bounds how far the carry reaches', async () => {
  // Created 20 months before the current period, so 8 of those months fall
  // outside the 12-period window and must not contribute.
  const budget = await makeBudget({
    amount: 1000,
    rolloverEnabled: true,
    createdAt: new Date(2024, 7, 1), // 2024-08-01
  });
  // One dollar of spend inside the window and one outside it.
  await spend('2024-09-15', -1000); // outside the 12-month window
  await spend('2026-01-15', -250); // inside

  const { progress, priorPeriodCount, anchorStart } = await load(budget);
  assert.equal(priorPeriodCount, 12);
  assert.equal(anchorStart, '2025-04-01'); // 12 months before 2026-04-01
  // 12 whole allowances minus only the in-window spend.
  assert.equal(progress.carriedIn, 12000 - 250);
});
