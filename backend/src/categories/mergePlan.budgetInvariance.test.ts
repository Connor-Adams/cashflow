// backend/src/categories/mergePlan.budgetInvariance.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryAndDescendantNames, computeBudgetProgress } from '../routes/budgets';
import type { CategoryTree } from './rollup';
import { normalizeCategoryName } from './normalizeName';
import { planCategoryMerges, subtreeNames, type PlanBudget, type PlanCategory } from './mergePlan';
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

/** Lift bare fixture rows into the planner's PlanCategory shape. */
function planCats(cats: FixtureCategory[]): PlanCategory[] {
  return cats.map((c) => ({
    ...c, householdId: HOUSEHOLD_ID, nameKey: normalizeCategoryName(c.name),
  }));
}

/**
 * Run the planner over a small hand-built shape with its own reference counts.
 * The checked-in fixture is a faithful production snapshot and must stay that
 * way, but production happens not to contain every case the rules must handle —
 * a reference-heavy YOUNGER id, an exact reference tie, a loser with children.
 * Those shapes are built here instead of being smuggled into the snapshot.
 */
function planSynthetic(
  cats: FixtureCategory[],
  refCounts: Record<number, number>,
  budgets: PlanBudget[] = [],
) {
  return planCategoryMerges(planCats(cats), refCounts, budgets);
}

/** Apply a MergePlan to the fixture rows, mirroring exactly what the migration does. */
function applyPlan(cats: FixtureCategory[], budgets: FixtureBudget[]) {
  const plan = planCategoryMerges(
    planCats(cats),
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

/**
 * The production groups pin WHICH rows merge, but they cannot pin WHY. In all 15
 * of them the reference-heavy node also happens to carry the lower id (28<85,
 * 30<81, 31<72, 13<75, 24<83, 59<79, 55<78, 22<71, 37<77, 19<76, 32<69, 14<74,
 * 6<73, 40<82, 20<80), so replacing the comparator with a plain
 * `sort((a, b) => a.id - b.id)` reproduces every pair below. Rule W is
 * discriminated by the two synthetic tests that follow, not by this one.
 */
test('the plan deletes exactly these 15 losers, and no loser has children', () => {
  const { plan } = applyPlan(FIXTURE_CATEGORIES, FIXTURE_BUDGETS);
  const pairs = plan.merges.map((m) => `${m.loserId}->${m.winnerId}`).sort();
  assert.deepEqual(pairs, [
    '69->32', '71->22', '72->31', '73->6', '74->14', '75->13', '76->19', '77->37',
    '78->55', '79->59', '80->20', '81->30', '82->40', '83->24', '85->28',
  ].sort());
  assert.equal(plan.reparents.length, 0, 'every loser is childless in this shape');
});

test('Rule W picks the reference-heavy node even when it is the YOUNGER id', () => {
  // The discriminating case production does not contain: the reference-heavy node
  // carries the HIGHER id, so "most references wins" and "oldest id wins" give
  // opposite answers. Rows are listed lowest-id-first so neither array order nor
  // id order can produce the expected result by accident.
  const plan = planSynthetic(
    [
      { id: 10, parentId: null, name: 'Zed' },
      { id: 20, parentId: null, name: 'Zed' },
    ],
    { 10: 1, 20: 5 },
  );
  assert.deepEqual(
    plan.merges.map((m) => ({ winnerId: m.winnerId, loserId: m.loserId })),
    [{ winnerId: 20, loserId: 10 }],
    'id 20 carries 5 references to id 10\'s 1, so 20 must win; an id-only sort says 10',
  );
});

test('Rule W breaks an exact reference tie to the lower (oldest) id', () => {
  // No production group has equal counts, so the comparator's `|| a.id - b.id`
  // tie-break is otherwise unreachable. Rows are listed highest-id-first so
  // Array#sort stability cannot supply the answer either.
  const plan = planSynthetic(
    [
      { id: 40, parentId: null, name: 'Tie' },
      { id: 30, parentId: null, name: 'Tie' },
    ],
    { 30: 7, 40: 7 },
  );
  assert.deepEqual(
    plan.merges.map((m) => ({ winnerId: m.winnerId, loserId: m.loserId })),
    [{ winnerId: 30, loserId: 40 }],
    'equal references must resolve to the lower id',
  );
});

/**
 * The WHOLE budgetActions array, in budget order. Asserting only the detach
 * subset left the repoint TARGET unpinned, so pointing every repointed budget at
 * the very row the migration is about to DELETE passed — a dangling
 * `category_id` on budgets 5, 6, 10, 12 and 14 in production.
 *
 * Budgets absent from this list need no rewrite: they are anchored on a row that
 * survives, and (because no loser has children here) their counted set does not
 * widen. Budgets 7 `Household` and 22 `Hobbies` are already `category_id = NULL`.
 */
test('the plan rewrites exactly seven budgets: five repointed at their winner, two detached', () => {
  const { plan } = applyPlan(FIXTURE_CATEGORIES, FIXTURE_BUDGETS);
  assert.deepEqual(plan.budgetActions, [
    { budgetId: 5, action: 'repoint', categoryId: 31 },   // cc fees    72 -> 31
    { budgetId: 6, action: 'repoint', categoryId: 32 },   // Groceries  69 -> 32
    { budgetId: 10, action: 'repoint', categoryId: 22 },  // Eating Out 71 -> 22
    { budgetId: 12, action: 'repoint', categoryId: 30 },  // Alcohol    81 -> 30
    { budgetId: 14, action: 'repoint', categoryId: 40 },  // Vape       82 -> 40
    // Rule B: winner 13 `Clothing` owns `Snowboarding Gear`, winner 19 `Golf`
    // owns `Clublink`; repointing would make these budgets count a new name.
    { budgetId: 16, action: 'detach', categoryId: null },
    { budgetId: 17, action: 'detach', categoryId: null },
  ]);
});

/**
 * Rule B is about WIDENING, not about CHANGE. A budget on an ANCESTOR of a loser
 * sees its counted set NARROW: loser 74 `Office Equipment` sits under 48
 * `Household`, and the winner 14 is a root, so deleting 74 removes the name
 * `Office Equipment` from 48's subtree. That is the deduplication working. A
 * `sets differ` predicate would detach `Household` and stop it rolling up Rent,
 * Internet, Groceries and the rest — a far bigger regression than the one Rule B
 * guards against.
 */
test('Rule B does NOT touch a budget whose counted set only NARROWS', () => {
  const rows = planCats(FIXTURE_CATEGORIES);
  const before = subtreeNames(rows, 48);
  assert.ok(before.has('Office Equipment'), 'precondition: loser 74 sits under 48 Household');
  assert.ok(before.has('Rent') && before.has('Internet'), 'precondition: 48 rolls up real spend');

  const plan = planCategoryMerges(rows, FIXTURE_REF_COUNTS, [{ id: 901, categoryId: 48 }]);
  assert.deepEqual(plan.budgetActions, [], 'a narrowing budget must be left exactly as it is');
});

/**
 * The `reparents` branch can widen a budget that never pointed at a loser, so
 * Rule B has to evaluate EVERY anchored budget. Guarding with
 * `!winnerByLoser.has(b.categoryId)` skipped precisely this budget: winner 1
 * adopts `Beta` from loser 2, and a budget anchored on 1 silently starts counting
 * `Beta`. Production has no loser with children today; nothing stops one
 * appearing.
 */
test('Rule B detaches a budget on a WINNER that adopts a loser\'s children', () => {
  const plan = planSynthetic(
    [
      { id: 1, parentId: null, name: 'Alpha' },
      { id: 2, parentId: null, name: 'Alpha' },
      { id: 3, parentId: 2, name: 'Beta' },
    ],
    { 1: 10, 2: 1 },
    [{ id: 101, categoryId: 1 }, { id: 102, categoryId: 2 }],
  );
  assert.deepEqual(plan.merges.map((m) => `${m.loserId}->${m.winnerId}`), ['2->1']);
  assert.deepEqual(plan.reparents, [{ childId: 3, newParentId: 1 }],
    'the planner itself moves Beta under the winner');
  assert.deepEqual(plan.budgetActions, [
    // 101 was on the winner and counted {Alpha}; post-merge it would count
    // {Alpha, Beta}. Widened -> detach.
    { budgetId: 101, action: 'detach', categoryId: null },
    // 102 was on the loser and already counted {Alpha, Beta}; the winner counts
    // the same two names afterwards. Unchanged -> plain repoint.
    { budgetId: 102, action: 'repoint', categoryId: 1 },
  ]);
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
 * Rule W is pinned by the two synthetic 'Rule W ...' tests above — NOT by
 * 'the plan deletes exactly these 15 losers', which an id-only comparator also
 * satisfies. Rule B is pinned by the full-array assertion in 'the plan rewrites
 * exactly seven budgets ...' plus the narrowing and reparent tests above.
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
 * What this pins, precisely.
 *
 * PINS `computeBudgetProgress`'s two pricing branches, over the shape Rule B
 * produces: `category_id = NULL` with the `category` NAME string retained prices
 * as an EXACT-name match with no rollup, while a non-null `categoryId` prices as
 * a rollup over `categoryAndDescendantNames`. Verified by mutating `budgets.ts`:
 * collapsing the exact-name branch fails this test. It is also why the migration
 * must write these two rows with raw SQL — `reconcileCategoryField` nulls the
 * `category` string whenever `categoryId` changes, which would turn these budgets
 * into whole-currency totals (`category == null` is the total-by-currency branch)
 * instead of exact-name budgets. A later task's migration test enforces that
 * against a real database.
 *
 * It also shows, in dollars, WHY Rule B exists: rolling budget 17 up onto winner
 * 19 would add `Clublink`'s spend on top of what it already counts.
 *
 * DOES NOT make Rule B falsifiable. Its only discriminating plan assertion —
 * `action === 'detach'` for budgets 16 and 17 — duplicates the full-array
 * assertion above, and its `naive` arithmetic prices a shape the planner never
 * emits (a budget left pointing at a rollup winner). Rule B's falsifiable tests
 * are the narrowing and reparent tests above.
 */
test('a detached budget prices by exact name; a rollup onto the winner would inflate it', () => {
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
