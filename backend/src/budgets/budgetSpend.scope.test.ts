/**
 * Household scoping of the budget spend pipeline.
 *
 * A budget belongs to exactly one household, so its spend aggregate must be
 * scoped to THAT household — never to whatever the caller happens to be able to
 * see. `householdWhere(req)` (backend/src/auth/scope.ts) returns `{}` for a
 * superadmin, and the route used to forward it straight into the spend query,
 * so a superadmin's `spent`/`remaining`/`percentUsed`/`pacingState` summed every
 * household's transactions against one household's target. The daily breach
 * cron never had the bug because it pinned `{ householdId: budget.householdId }`
 * itself; these tests lock the two callers to the cron's behavior.
 *
 * The same rule applies to the category tree used for subtree rollup: a budget
 * on a parent category must roll up ITS household's descendants, so
 * `loadBudgetStatuses` loads one tree per distinct household rather than one
 * tree for the caller.
 *
 * `now` is injected, so nothing here depends on the wall clock.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { sequelize } from '../db';
import * as models from '../models';
import {
  loadBudgetSpend,
  loadBudgetStatuses,
  toBudgetSpendInput,
} from './budgetSpend';
import { loadCategoryTree } from '../categories/rollup';

const CURRENCY = 'CAD';
const CATEGORY = 'Dining';
const CHILD_CATEGORY = 'Coffee';
/** Mid-April 2026. The current monthly period is 2026-04-01..2026-04-30. */
const NOW = new Date(2026, 3, 15, 12, 0, 0);
const IN_PERIOD = '2026-04-10';

type Fixture = { householdId: number; accountId: number };

/** The budget's own household. */
let own: Fixture;
/** A second household whose rows must never reach the budget's aggregate. */
let other: Fixture;

async function makeHousehold(name: string): Promise<Fixture> {
  const hh = await models.Household.create({ name });
  const account = await models.Account.create({
    householdId: hh.id,
    ownerUserId: null,
    owner: 'me',
    visibility: 'shared',
    name: `${name} card`,
    accountType: 'credit',
    defaultCurrency: CURRENCY,
    shortCode: name.slice(0, 3).toUpperCase(),
  });
  return { householdId: hh.id, accountId: account.id };
}

beforeEach(async () => {
  await sequelize.sync({ force: true });
  own = await makeHousehold('Own');
  other = await makeHousehold('Other');
});

/**
 * Seed one transaction. `amount` follows the app's sign convention: spend is
 * NEGATIVE (`aggregateSpendByCategory` skips any row with `amount >= 0`) and a
 * refund is positive. An explicit `category: null` survives the defaults below,
 * which is the uncategorized case.
 */
async function spend(
  where: Fixture,
  amount: number,
  {
    date = IN_PERIOD,
    category = CATEGORY as string | null,
    txnType = 'purchase',
    linkedTransactionId = null,
  }: {
    date?: string;
    category?: string | null;
    txnType?: string;
    linkedTransactionId?: number | null;
  } = {},
): Promise<number> {
  const row = await models.Transaction.create({
    accountId: where.accountId,
    householdId: where.householdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'scope-test',
    date,
    merchantRaw: 'Somewhere',
    merchantClean: 'Somewhere',
    amount: amount.toFixed(4),
    currency: CURRENCY,
    txnType,
    linkedTransactionId,
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
  });
  return row.id;
}

async function makeBudget(
  where: Fixture,
  {
    amount,
    category = CATEGORY as string | null,
    categoryId = null,
    excludeRefundedPurchases = false,
  }: {
    amount: number;
    category?: string | null;
    categoryId?: number | null;
    excludeRefundedPurchases?: boolean;
  },
) {
  const row = await models.BudgetTarget.create({
    householdId: where.householdId,
    category,
    categoryId,
    currency: CURRENCY,
    amount: amount.toFixed(4),
    period: 'monthly',
    scope: 'household',
    rolloverEnabled: false,
    excludeRefundedPurchases,
  });
  const reloaded = await models.BudgetTarget.findByPk(row.id);
  assert.ok(reloaded);
  return reloaded;
}

// ---- loadBudgetSpend -------------------------------------------------------

test('loadBudgetSpend: counts only the budget household, never another household', async () => {
  await spend(own, -100);
  await spend(other, -900);
  const budget = await makeBudget(own, { amount: 1000 });

  const { progress } = await loadBudgetSpend({
    budget: toBudgetSpendInput(budget),
    tree: await loadCategoryTree(own.householdId),
    now: NOW,
  });

  assert.equal(progress.spent, 100);
  assert.equal(progress.remaining, 900);
  assert.equal(progress.percentUsed, 10);
});

test('loadBudgetSpend: an overall (category=null) budget is household-scoped too', async () => {
  // The category==null branch sums the whole currency bucket, so an unscoped
  // query leaks every household's spend regardless of category.
  await spend(own, -50, { category: 'Rent' });
  await spend(other, -4000, { category: 'Rent' });
  const budget = await makeBudget(own, { amount: 1000, category: null });

  const { progress } = await loadBudgetSpend({
    budget: toBudgetSpendInput(budget),
    tree: await loadCategoryTree(own.householdId),
    now: NOW,
  });

  assert.equal(progress.spent, 50);
});

test('loadBudgetSpend: refund netting ignores another household refunds', async () => {
  // Both households buy; only the other household refunds. Netting that refund
  // into this budget would understate spend by the refunded amount.
  const otherPurchase = await spend(other, -300);
  await spend(other, 120, {
    txnType: 'refund',
    linkedTransactionId: otherPurchase,
  });
  await spend(own, -200);
  const budget = await makeBudget(own, {
    amount: 1000,
    excludeRefundedPurchases: true,
  });

  const { progress } = await loadBudgetSpend({
    budget: toBudgetSpendInput(budget),
    tree: await loadCategoryTree(own.householdId),
    now: NOW,
  });

  assert.equal(progress.spent, 200);
});

// ---- loadBudgetStatuses ----------------------------------------------------

test('loadBudgetStatuses: each budget rolls up its OWN household category subtree', async () => {
  // Same category names in both households, distinct ids. A single shared tree
  // resolves only one household's ids, so the other budget silently loses its
  // subtree rollup and reports the parent's direct spend only.
  const trees = await Promise.all(
    [own, other].map(async (hh) => {
      const parent = await models.Category.create({
        householdId: hh.householdId,
        parentId: null,
        name: CATEGORY,
        icon: null,
      });
      await models.Category.create({
        householdId: hh.householdId,
        parentId: parent.id,
        name: CHILD_CATEGORY,
        icon: null,
      });
      return parent.id;
    }),
  );
  const [ownParentId, otherParentId] = trees;

  await spend(own, -10);
  await spend(own, -5, { category: CHILD_CATEGORY });
  await spend(other, -20);
  await spend(other, -7, { category: CHILD_CATEGORY });

  const ownBudget = await makeBudget(own, {
    amount: 1000,
    categoryId: ownParentId,
  });
  const otherBudget = await makeBudget(other, {
    amount: 1000,
    categoryId: otherParentId,
  });

  const items = await loadBudgetStatuses({
    budgets: [ownBudget, otherBudget].map(toBudgetSpendInput),
    now: NOW,
  });

  const byId = new Map(items.map((i) => [i.budgetId, i]));
  assert.equal(byId.get(ownBudget.id)?.spent, 15);
  assert.equal(byId.get(otherBudget.id)?.spent, 27);
});

test('loadBudgetStatuses: budgets in different households do not pool spend', async () => {
  await spend(own, -100);
  await spend(other, -900);
  const ownBudget = await makeBudget(own, { amount: 1000 });
  const otherBudget = await makeBudget(other, { amount: 1000 });

  const items = await loadBudgetStatuses({
    budgets: [ownBudget, otherBudget].map(toBudgetSpendInput),
    now: NOW,
  });

  const byId = new Map(items.map((i) => [i.budgetId, i]));
  assert.equal(byId.get(ownBudget.id)?.spent, 100);
  assert.equal(byId.get(otherBudget.id)?.spent, 900);
});
