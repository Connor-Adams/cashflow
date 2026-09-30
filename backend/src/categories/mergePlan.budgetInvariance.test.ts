// backend/src/categories/mergePlan.budgetInvariance.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryAndDescendantNames, computeBudgetProgress } from '../routes/budgets';
import type { CategoryTree } from './rollup';
import { normalizeCategoryName } from './normalizeName';
import { planCategoryMerges } from './mergePlan';
import {
  FIXTURE_BUDGETS, FIXTURE_CATEGORIES, FIXTURE_REF_COUNTS, FIXTURE_SPEND, HOUSEHOLD_ID,
  type FixtureBudget, type FixtureCategory, type FixtureSpend,
} from './mergePlanFixture';

const BOUNDS = { periodStart: '2026-09-01', periodEnd: '2026-09-30' };
const SEP = '\0';

function treeOf(cats: FixtureCategory[]): CategoryTree {
  const parentById = new Map<number, number | null>();
  const nameById = new Map<number, string>();
  for (const c of cats) { parentById.set(c.id, c.parentId); nameById.set(c.id, c.name); }
  return { parentById, nameById, depthById: new Map(), pathById: new Map() };
}

function spendMap(rows: FixtureSpend[]) {
  const m = new Map<string, { currency: string; category: string | null; spent: number }>();
  for (const r of rows) {
    const key = `${r.currency}${SEP}${r.finalCategory}`;
    const prev = m.get(key);
    m.set(key, {
      currency: r.currency, category: r.finalCategory, spent: (prev?.spent ?? 0) + r.spent,
    });
  }
  return m;
}

function spentByBudget(cats: FixtureCategory[], budgets: FixtureBudget[], spend: FixtureSpend[]) {
  const tree = treeOf(cats);
  const progress = computeBudgetProgress(
    budgets.map((b) => ({
      id: b.id, category: b.category, currency: b.currency, amount: b.amount,
      categoryNames: b.categoryId != null ? categoryAndDescendantNames(tree, b.categoryId) : null,
    })),
    spendMap(spend),
    BOUNDS,
  );
  return new Map(progress.map((p) => [p.budgetId, Number(p.spent.toFixed(2))]));
}

/** Apply a MergePlan to the fixture rows, mirroring exactly what the migration does. */
function applyPlan(cats: FixtureCategory[], budgets: FixtureBudget[]) {
  const plan = planCategoryMerges(
    cats.map((c) => ({ ...c, householdId: HOUSEHOLD_ID, nameKey: normalizeCategoryName(c.name) })),
    FIXTURE_REF_COUNTS,
    budgets.map((b) => ({ id: b.id, categoryId: b.categoryId })),
  );
  const losers = new Set(plan.merges.map((m) => m.loserId));
  const reparent = new Map(plan.reparents.map((r) => [r.childId, r.newParentId]));
  const nextCats = cats
    .filter((c) => !losers.has(c.id))
    .map((c) => (reparent.has(c.id) ? { ...c, parentId: reparent.get(c.id)! } : c));
  const actions = new Map(plan.budgetActions.map((a) => [a.budgetId, a]));
  const nextBudgets = budgets.map((b) =>
    actions.has(b.id) ? { ...b, categoryId: actions.get(b.id)!.categoryId } : b);
  return { plan, nextCats, nextBudgets };
}

/** Phase 5(b): rewrite a path-form final_category to its leaf segment. */
function repairPaths(spend: FixtureSpend[]): FixtureSpend[] {
  return spend.map((r) =>
    r.finalCategory.includes('/')
      ? { ...r, finalCategory: r.finalCategory.split('/').map((s) => s.trim()).pop()! }
      : r);
}

test('the plan picks the reference-heavy node and deletes exactly 15 losers', () => {
  const { plan } = applyPlan(FIXTURE_CATEGORIES, FIXTURE_BUDGETS);
  const pairs = plan.merges.map((m) => `${m.loserId}->${m.winnerId}`).sort();
  assert.deepEqual(pairs, [
    '69->32', '71->22', '72->31', '73->6', '74->14', '75->13', '76->19', '77->37',
    '78->55', '79->59', '80->20', '81->30', '82->40', '83->24', '85->28',
  ].sort());
  assert.equal(plan.reparents.length, 0, 'every loser is childless in this shape');
});

test('Rule B detaches exactly the two budgets whose counted set would widen', () => {
  const { plan } = applyPlan(FIXTURE_CATEGORIES, FIXTURE_BUDGETS);
  const detached = plan.budgetActions
    .filter((a) => a.action === 'detach')
    .map((a) => a.budgetId)
    .sort((a, b) => a - b);
  assert.deepEqual(detached, [16, 17], 'Clothing and Golf, whose winners have children');
  for (const a of plan.budgetActions.filter((x) => x.action === 'detach')) {
    assert.equal(a.categoryId, null);
  }
});

test('the merge alone changes no budget spend at all', () => {
  const before = spentByBudget(FIXTURE_CATEGORIES, FIXTURE_BUDGETS, FIXTURE_SPEND);
  const { nextCats, nextBudgets } = applyPlan(FIXTURE_CATEGORIES, FIXTURE_BUDGETS);
  const after = spentByBudget(nextCats, nextBudgets, FIXTURE_SPEND);
  assert.equal(after.size, before.size);
  for (const [budgetId, spent] of before) {
    assert.equal(after.get(budgetId), spent, `budget ${budgetId} spend moved on merge alone`);
  }
});

test('the path-form repair moves exactly three budgets, to exactly these values', () => {
  const before = spentByBudget(FIXTURE_CATEGORIES, FIXTURE_BUDGETS, FIXTURE_SPEND);
  const { nextCats, nextBudgets } = applyPlan(FIXTURE_CATEGORIES, FIXTURE_BUDGETS);
  const after = spentByBudget(nextCats, nextBudgets, repairPaths(FIXTURE_SPEND));

  const INTENDED = new Map<number, number>([
    [8, 628.65],  // Healthcare: + Dentist 252.00 + Diabetes 204.52
    [9, 31.41],   // Transportation: + Gas 3.49
    [14, 265.48], // Vape: Household / Vape, previously counted nowhere
  ]);
  for (const [budgetId, expected] of INTENDED) {
    assert.equal(after.get(budgetId), expected, `intended change for budget ${budgetId}`);
    assert.notEqual(before.get(budgetId), expected);
  }
  for (const [budgetId, spent] of before) {
    if (INTENDED.has(budgetId)) continue;
    assert.equal(after.get(budgetId), spent, `budget ${budgetId} moved but was not intended to`);
  }
});

test('the no-rollup budgets keep a name string when their id is detached', () => {
  const { nextBudgets } = applyPlan(FIXTURE_CATEGORIES, FIXTURE_BUDGETS);
  for (const id of [16, 17]) {
    const row = nextBudgets.find((b) => b.id === id)!;
    assert.equal(row.categoryId, null);
    assert.ok(row.category.length > 0,
      'reconcileCategoryField nulls the string when the id changes; the migration must write raw SQL');
  }
});
