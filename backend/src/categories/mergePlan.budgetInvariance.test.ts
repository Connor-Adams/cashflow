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

/**
 * One budget's spend, with `categoryId` supplied by the caller rather than read
 * off the row — so a single budget can be priced under the before shape, the
 * plan's chosen shape, and a hypothetical wrong shape, from the same spend rows.
 */
function spentForCategoryId(
  cats: FixtureCategory[],
  budget: FixtureBudget,
  categoryId: number | null,
  spend: FixtureSpend[],
): number {
  const tree = treeOf(cats);
  const [progress] = computeBudgetProgress(
    [{
      id: budget.id,
      category: budget.category,
      currency: budget.currency,
      amount: budget.amount,
      categoryNames: categoryId != null ? categoryAndDescendantNames(tree, categoryId) : null,
    }],
    spendMap(spend),
    BOUNDS,
  );
  return Number(progress.spent.toFixed(2));
}

function budgetById(id: number): FixtureBudget {
  const row = FIXTURE_BUDGETS.find((b) => b.id === id);
  assert.ok(row, `fixture budget ${id}`);
  return row;
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

/**
 * What this proves, and what it does not.
 *
 * PROVES: no budget's September-2026 spend moves as a side effect of the merge.
 * It is a regression net for spend MOVEMENT across all 23 budgets at once —
 * valuable if a future change to the planner starts shifting figures.
 *
 * DOES NOT prove the merge rules are right. `computeBudgetProgress` keys spend by
 * category NAME, and both halves of every duplicate pair share a name by
 * construction, so swapping which half wins moves nothing here: Rule W is
 * invisible to this test. Rule B is invisible too, because the only two
 * categories it protects (`Snowboarding Gear` under Clothing 13, `Clublink`
 * under Golf 19) happen to have zero September-2026 spend. Both mutations —
 * Rule W picking the FEWEST references, Rule B disabled entirely — leave this
 * test green.
 *
 * Rule W is pinned by 'the plan picks the reference-heavy node...' above.
 * Rule B is pinned by 'Rule B prevents the Clublink double-count...' below.
 * This test alone is NOT evidence that the merge is safe.
 */
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

/**
 * The falsifiable Rule B test. Prices budget 17 (`Golf`) three ways over the same
 * spend rows and pins the plan's answer to the before figure while showing the
 * naive alternative is measurably wrong. Deleting Rule B from the planner — or
 * making it always `repoint` — fails this test.
 *
 * Note the shape Rule B produces: `category_id = NULL` with the `category` NAME
 * string retained, which `computeBudgetProgress` prices as an exact-name match
 * with no rollup. That is the behaviour under test here, and the reason the
 * migration must write these two rows with raw SQL: `reconcileCategoryField`
 * nulls the `category` string whenever `categoryId` changes, which would turn
 * these budgets into whole-currency totals (`category == null` is the
 * total-by-currency branch) instead of exact-name budgets. A later task's
 * migration test enforces that against a real database.
 */
test('Rule B prevents the Clublink double-count that a naive repoint would cause', () => {
  // SYNTHETIC ROWS. `Clublink` and `Snowboarding Gear` have no September 2026
  // spend in prod, so the real fixture cannot exercise the trap that motivated
  // Rule B: a child name that only a rolled-up winner would pull in. One row per
  // trap, added here rather than in mergePlanFixture.ts so the checked-in fixture
  // stays a faithful production snapshot.
  const CLUBLINK = 879;
  const SNOWBOARDING = 512.25;
  const spend: FixtureSpend[] = [
    ...FIXTURE_SPEND,
    { currency: 'CAD', finalCategory: 'Clublink', spent: CLUBLINK },
    { currency: 'CAD', finalCategory: 'Snowboarding Gear', spent: SNOWBOARDING },
  ];

  const { plan, nextCats } = applyPlan(FIXTURE_CATEGORIES, FIXTURE_BUDGETS);
  const actionOf = (budgetId: number) => {
    const a = plan.budgetActions.find((x) => x.budgetId === budgetId);
    assert.ok(a, `plan has an action for budget ${budgetId}`);
    return a;
  };

  const TRAPS = [
    // budget, childless duplicate root (before), rollup winner (naive), trap name
    { budgetId: 17, beforeId: 76, naiveId: 19, delta: CLUBLINK, trap: 'Clublink' },
    { budgetId: 16, beforeId: 75, naiveId: 13, delta: SNOWBOARDING, trap: 'Snowboarding Gear' },
  ];

  for (const { budgetId, beforeId, naiveId, delta, trap } of TRAPS) {
    const budget = budgetById(budgetId);
    assert.equal(budget.categoryId, beforeId, `budget ${budgetId} starts on the duplicate root`);

    // 1. Before the merge: the childless duplicate root counts its own name only.
    const before = spentForCategoryId(FIXTURE_CATEGORIES, budget, beforeId, spend);

    // 2. With Rule B: the plan detaches, so the budget prices by exact name.
    const action = actionOf(budgetId);
    assert.equal(action.action, 'detach', `Rule B must detach budget ${budgetId}`);
    assert.equal(action.categoryId, null);
    const ruleB = spentForCategoryId(nextCats, budget, action.categoryId, spend);
    assert.equal(ruleB, before,
      `INVARIANT: budget ${budgetId} counts the same spend after the merge as before it`);

    // 3. With a naive repoint onto the winner: ${trap} is rolled up and double-counted.
    const naive = spentForCategoryId(nextCats, budget, naiveId, spend);
    assert.equal(naive, Number((before + delta).toFixed(2)),
      `a naive repoint of budget ${budgetId} onto ${naiveId} adds ${trap}'s ${delta}`);
    assert.ok(naive > before,
      `a naive repoint of budget ${budgetId} inflates its spend`);
    assert.notEqual(naive, ruleB,
      `Rule B and the naive repoint must differ for budget ${budgetId}, or this test proves nothing`);
  }
});
