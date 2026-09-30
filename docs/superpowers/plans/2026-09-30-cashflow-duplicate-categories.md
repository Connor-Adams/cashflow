# Duplicate Categories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the nightly enrichment job forking categories, merge the 15 existing duplicate pairs without changing what any budget counts, and make the duplicate shape unrepresentable.

**Architecture:** A pure planning function in `backend/lib/categoryMergePlan.js` decides winners, losers, reparents and budget actions from plain rows. The Sequelize migration executes that plan against the live DB; a colocated golden test runs the same plan against a checked-in snapshot of the real household-1 shape and asserts per-budget `spent` is unchanged except three rows. The write-path fix makes `resolveCategoryPath` resolve names household-globally instead of parent-scoped, and the AI writers persist the category id alongside a flat leaf name.

**Tech Stack:** TypeScript, Sequelize 6, `node:test` via `tsx` (backend unit tests), Postgres in prod / SQLite for unit tests, plain CommonJS for `backend/lib/` and migrations.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-30-cashflow-duplicate-categories-design.md`. Read it before Task 1.
- **Run every command from the repo root.** Worktrees have their own `node_modules`; if it is missing, run `corepack yarn install` inside the worktree.
- Backend unit tests are **colocated**: `foo.test.ts` beside `foo.ts` under `backend/src/`. Migration tests are the carve-out — they live in `backend/src/migrations/__tests__/`, never in `src/migrations/`, because `sequelize-cli` scans that directory for migrations.
- Single backend test file: `cd backend && yarn tsx --import ./test/setup.ts --test src/<path>.test.ts`
- Write Sequelize that runs on **both** SQLite and Postgres.
- Migrations are plain CommonJS JavaScript in `backend/src/migrations/`, named `YYYYMMDD......-slug.js`.
- Shared app/migration code goes in `backend/lib/<name>.js` (CommonJS) with a sibling `<name>.d.ts`, per commit `7219ad43`. `require('../../lib/<name>')` resolves identically from `src/`, `dist/` and `src/migrations/`.
- **No commit may carry a `Co-Authored-By` line or any attribution trailer.**
- Nothing in Tasks 1-7 touches production. Prod execution is Task 8 and is gated on Connor's explicit approval of the dry-run report.

## Two rules that replace per-pair judgment

Both were verified against all 15 prod pairs and reproduce the human decision exactly.

**Rule W — winner selection.** Within a `(household_id, name_key)` duplicate group, the winner is the node with the highest total reference count across every referencing column; ties break to the lowest id. This picks the nested child in 14 pairs and the root (id 14, `Office Equipment`) in the inverted one.

**Rule B — a merge must never widen a budget.** When a `budget_targets` row points at a loser, compare the set of names the budget counted before the merge with the set it would count after. If they differ, set `category_id = NULL` and leave the `category` string alone — the exact-name no-rollup form that budgets 7 (`Household`) and 22 (`Hobbies`) already use — instead of repointing. This fires on exactly two rows: budget 17 (`Golf`, whose winner 19 has `Clublink`) and budget 16 (`Clothing`, whose winner 13 has `Snowboarding Gear`).

## File Structure

| File | Responsibility |
|---|---|
| `backend/lib/categoryMergePlan.js` (create) | Pure planner: rows in, `MergePlan` out. No DB, no Sequelize. Shared by the migration and the test. |
| `backend/lib/categoryMergePlan.d.ts` (create) | Type contract for the above. |
| `backend/src/categories/mergePlan.ts` (create) | Typed facade re-exporting the planner into TypeScript, per the `normalizeMerchant.ts` pattern. |
| `backend/src/categories/mergePlanFixture.ts` (create) | Checked-in snapshot of the real household-1 shape: 80 categories, 23 budget targets, September 2026 spend buckets. |
| `backend/src/categories/mergePlan.budgetInvariance.test.ts` (create) | The golden test. The deliverable. |
| `backend/src/categories/resolvePath.ts` (modify) | Segment lookup goes household-global. |
| `backend/src/util/ensureCategory.ts` (modify) | Returns the resolved leaf instead of `void`. |
| `backend/src/import/enrichment/aiBatchOverColdRows.ts` (modify :136-195) | Resolve before the static update; persist id + flat name. |
| `backend/src/import/enrichment/embeddingMatchOverColdRows.ts` (modify :99-162) | Same. |
| `backend/src/amazon/aiCategorizeAmazonItems.ts` (modify :336-355) | Same, for `inferredCategory`. |
| `backend/src/categories/errors.ts` (modify) | Add `name_conflict`. |
| `backend/src/categories/createCategory.ts` (modify) | Conflict check goes household-global. |
| `backend/src/categories/reparent.ts` (modify) | Same. |
| `backend/src/routes/categories.ts` (modify :171-177) | Rename conflict check goes household-global. |
| `backend/src/models/Category.ts` (modify :67-80) | Declared indexes follow the migration. |
| `backend/src/migrations/20260930000001-merge-duplicate-category-names.js` (create) | Executes the plan, then swaps the indexes. |
| `backend/src/migrations/20260930000002-repair-category-string-id-pairs.js` (create) | Phase 5 data repair. |
| `backend/src/migrations/__tests__/mergeDuplicateCategoryNamesMigration.test.ts` (create) | Migration 1 behaviour against a real DB. |
| `backend/src/migrations/__tests__/repairCategoryStringIdPairsMigration.test.ts` (create) | Migration 2 behaviour. |

## What this plan deliberately does NOT change

`ai/suggestTransaction.ts:15` `loadCategoryHints` keeps returning **path-form** strings (`tree.pathById.values()`). Do not "fix" it to emit flat names. Once Task 2 lands, a path-form model response resolves to the correct leaf and Task 4 writes the leaf's flat name, so the path form is harmless — and the hierarchy is useful context for the model. Removing it would make categorization worse for no benefit.

`categories/resolveCategoryId.ts` also needs no change. Under a household-wide unique name its `matches` array holds 0 or 1 rows, so steps 1 and 2 always decide and the step-3 `findOrCreate` ambiguity branch becomes unreachable. Leave it — it is the correct fallback for a name that exists nowhere.

---

### Task 1: The merge planner and the budget-invariance golden test

This is the deliverable. It must exist and pass before any migration is written.

**Files:**
- Create: `backend/lib/categoryMergePlan.js`
- Create: `backend/lib/categoryMergePlan.d.ts`
- Create: `backend/src/categories/mergePlanFixture.ts`
- Test: `backend/src/categories/mergePlan.budgetInvariance.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `planCategoryMerges(categories, refCounts, budgets) => MergePlan`, required by Task 6. `MergePlan` is `{ merges: Merge[], reparents: Reparent[], budgetActions: BudgetAction[] }` where `Merge` is `{ householdId: number; nameKey: string; winnerId: number; loserId: number }`, `Reparent` is `{ childId: number; newParentId: number }`, and `BudgetAction` is `{ budgetId: number; action: 'repoint' | 'detach'; categoryId: number | null }`.

- [ ] **Step 1: Write the fixture**

`backend/src/categories/mergePlanFixture.ts` — the real household-1 shape, pulled from prod on 2026-09-30. Names and amounts only; no merchants, accounts or dates.

```ts
// backend/src/categories/mergePlanFixture.ts
// A snapshot of Connor-Adams/cashflow household 1 taken 2026-09-30, used by
// mergePlan.budgetInvariance.test.ts to prove the duplicate-category merge does
// not change what any budget counts. Names and amounts only.
export type FixtureCategory = { id: number; parentId: number | null; name: string };
export type FixtureBudget = {
  id: number; category: string; categoryId: number | null; currency: string; amount: string;
};
/** September 2026 dashboard-eligible spend, keyed by the raw final_category string. */
export type FixtureSpend = { currency: string; finalCategory: string; spent: number };

export const HOUSEHOLD_ID = 1;

export const FIXTURE_CATEGORIES: FixtureCategory[] = [
  { id: 1, parentId: 39, name: 'Credit Reporting' },
  { id: 2, parentId: 51, name: 'Haircut' },
  { id: 3, parentId: null, name: 'Uncategorized' },
  { id: 4, parentId: 48, name: 'Yeti' },
  { id: 5, parentId: 38, name: 'Parking' },
  { id: 6, parentId: 53, name: 'Travel' },
  { id: 8, parentId: 6, name: 'ESim' },
  { id: 9, parentId: 53, name: 'Racing' },
  { id: 10, parentId: 14, name: 'Desk' },
  { id: 11, parentId: 48, name: 'Internet' },
  { id: 12, parentId: 48, name: 'Rent' },
  { id: 13, parentId: 48, name: 'Clothing' },
  { id: 14, parentId: null, name: 'Office Equipment' },
  { id: 15, parentId: 38, name: 'Miami Uber' },
  { id: 16, parentId: 19, name: 'Clublink' },
  { id: 17, parentId: 53, name: 'Games' },
  { id: 18, parentId: null, name: 'Payment' },
  { id: 19, parentId: 53, name: 'Golf' },
  { id: 20, parentId: 48, name: 'Weed' },
  { id: 21, parentId: 50, name: 'Spotify' },
  { id: 22, parentId: 48, name: 'Eating Out' },
  { id: 23, parentId: 13, name: 'Snowboarding Gear' },
  { id: 24, parentId: 51, name: 'Diabetes' },
  { id: 25, parentId: 38, name: 'Car' },
  { id: 26, parentId: 48, name: 'Coffee' },
  { id: 27, parentId: 14, name: 'Laptop' },
  { id: 28, parentId: 50, name: 'Ai' },
  { id: 29, parentId: null, name: 'Hosting' },
  { id: 30, parentId: 48, name: 'Alcohol' },
  { id: 31, parentId: 39, name: 'cc fees' },
  { id: 32, parentId: 48, name: 'Groceries' },
  { id: 33, parentId: 48, name: 'Biba' },
  { id: 34, parentId: null, name: 'Shipping' },
  { id: 35, parentId: 51, name: 'Dentist' },
  { id: 36, parentId: null, name: 'Transfer' },
  { id: 37, parentId: 38, name: 'Gas' },
  { id: 38, parentId: null, name: 'Transportation' },
  { id: 39, parentId: null, name: 'Accounting' },
  { id: 40, parentId: 48, name: 'Vape' },
  { id: 41, parentId: 39, name: 'Taxes' },
  { id: 42, parentId: null, name: 'Cottage' },
  { id: 43, parentId: null, name: 'ring' },
  { id: 44, parentId: null, name: 'Investments' },
  { id: 45, parentId: null, name: 'Investment income' },
  { id: 46, parentId: null, name: 'Other' },
  { id: 47, parentId: null, name: 'Electronics' },
  { id: 48, parentId: null, name: 'Household' },
  { id: 50, parentId: null, name: 'Subscriptions' },
  { id: 51, parentId: null, name: 'Healthcare' },
  { id: 52, parentId: null, name: 'Sephora' },
  { id: 53, parentId: null, name: 'Hobbies' },
  { id: 54, parentId: 50, name: 'Google One' },
  { id: 55, parentId: 29, name: 'Domains' },
  { id: 56, parentId: 6, name: 'France' },
  { id: 57, parentId: null, name: 'LuLu Lemon' },
  { id: 58, parentId: 48, name: 'Birthday Gifts' },
  { id: 59, parentId: 50, name: 'Discord Nitro' },
  { id: 61, parentId: null, name: 'tire air' },
  { id: 62, parentId: null, name: 'Internet Hardware' },
  { id: 67, parentId: null, name: 'Apple' },
  { id: 68, parentId: null, name: 'Amazon' },
  { id: 69, parentId: null, name: 'Groceries' },
  { id: 70, parentId: null, name: 'Dining' },
  { id: 71, parentId: null, name: 'Eating Out' },
  { id: 72, parentId: null, name: 'cc fees' },
  { id: 73, parentId: null, name: 'Travel' },
  { id: 74, parentId: 48, name: 'Office Equipment' },
  { id: 75, parentId: null, name: 'Clothing' },
  { id: 76, parentId: null, name: 'Golf' },
  { id: 77, parentId: null, name: 'Gas' },
  { id: 78, parentId: null, name: 'Domains' },
  { id: 79, parentId: null, name: 'Discord Nitro' },
  { id: 80, parentId: null, name: 'Weed' },
  { id: 81, parentId: null, name: 'Alcohol' },
  { id: 82, parentId: null, name: 'Vape' },
  { id: 83, parentId: null, name: 'Diabetes' },
  { id: 84, parentId: 48, name: 'Beverages' },
  { id: 85, parentId: null, name: 'Ai' },
  { id: 86, parentId: null, name: 'Insurance' },
  { id: 87, parentId: 86, name: 'Tenant Insurance' },
];

/**
 * Total references per category id across transactions.{final,auto,category_override}_category_id,
 * rules.category_id, budget_targets.category_id, income_entries.category_id and
 * external_order_items.{inferred,category_override}_category_id, measured in prod 2026-09-30.
 * Only the ids inside a duplicate group matter to Rule W; everything else is 0 here.
 */
export const FIXTURE_REF_COUNTS: Record<number, number> = {
  28: 16, 85: 2,
  30: 63, 81: 7,
  31: 217, 72: 3,
  13: 15, 75: 1,
  24: 43, 83: 2,
  59: 17, 79: 0,
  55: 9, 78: 0,
  22: 1226, 71: 15,
  37: 67, 77: 2,
  19: 36, 76: 1,
  32: 453, 69: 13,
  14: 134, 74: 0,
  6: 54, 73: 0,
  40: 41, 82: 9,
  20: 87, 80: 0,
};

export const FIXTURE_BUDGETS: FixtureBudget[] = [
  { id: 1, category: 'Rent', categoryId: 12, currency: 'CAD', amount: '2907.0000' },
  { id: 2, category: 'Clublink', categoryId: 16, currency: 'CAD', amount: '879.0000' },
  { id: 3, category: 'Internet', categoryId: 11, currency: 'CAD', amount: '204.0000' },
  { id: 4, category: 'Subscriptions', categoryId: 50, currency: 'CAD', amount: '45.0000' },
  { id: 5, category: 'cc fees', categoryId: 72, currency: 'CAD', amount: '40.0000' },
  { id: 6, category: 'Groceries', categoryId: 69, currency: 'CAD', amount: '700.0000' },
  { id: 7, category: 'Household', categoryId: null, currency: 'CAD', amount: '200.0000' },
  { id: 8, category: 'Healthcare', categoryId: 51, currency: 'CAD', amount: '350.0000' },
  { id: 9, category: 'Transportation', categoryId: 38, currency: 'CAD', amount: '100.0000' },
  { id: 10, category: 'Eating Out', categoryId: 71, currency: 'CAD', amount: '175.0000' },
  { id: 11, category: 'Dining', categoryId: 70, currency: 'CAD', amount: '50.0000' },
  { id: 12, category: 'Alcohol', categoryId: 81, currency: 'CAD', amount: '50.0000' },
  { id: 14, category: 'Vape', categoryId: 82, currency: 'CAD', amount: '25.0000' },
  { id: 15, category: 'Amazon', categoryId: 68, currency: 'CAD', amount: '200.0000' },
  { id: 16, category: 'Clothing', categoryId: 75, currency: 'CAD', amount: '75.0000' },
  { id: 17, category: 'Golf', categoryId: 76, currency: 'CAD', amount: '50.0000' },
  { id: 18, category: 'Office Equipment', categoryId: 14, currency: 'CAD', amount: '40.0000' },
  { id: 19, category: 'Other', categoryId: 46, currency: 'CAD', amount: '25.0000' },
  { id: 21, category: 'Apple', categoryId: 67, currency: 'CAD', amount: '150.0000' },
  { id: 22, category: 'Hobbies', categoryId: null, currency: 'CAD', amount: '1.0000' },
  { id: 23, category: 'Electronics', categoryId: 47, currency: 'CAD', amount: '1.0000' },
  { id: 24, category: 'France', categoryId: 56, currency: 'CAD', amount: '1.0000' },
  { id: 25, category: 'Insurance', categoryId: 86, currency: 'CAD', amount: '260.0000' },
];

/** September 2026, amount < 0, dashboard-eligible txn_types, keyed by raw final_category. */
export const FIXTURE_SPEND: FixtureSpend[] = [
  { currency: 'CAD', finalCategory: 'Accounting', spent: 22.6 },
  { currency: 'CAD', finalCategory: 'Alcohol', spent: 290.9 },
  { currency: 'CAD', finalCategory: 'Amazon', spent: 86.94 },
  { currency: 'CAD', finalCategory: 'Apple', spent: 59.28 },
  { currency: 'CAD', finalCategory: 'cc fees', spent: 21.99 },
  { currency: 'CAD', finalCategory: 'Dining', spent: 237.92 },
  { currency: 'CAD', finalCategory: 'Eating Out', spent: 17.73 },
  { currency: 'CAD', finalCategory: 'Groceries', spent: 878.06 },
  { currency: 'CAD', finalCategory: 'Healthcare', spent: 172.13 },
  { currency: 'CAD', finalCategory: 'Healthcare / Dentist', spent: 252.0 },
  { currency: 'CAD', finalCategory: 'Healthcare / Diabetes', spent: 204.52 },
  { currency: 'CAD', finalCategory: 'Hobbies', spent: 35.69 },
  { currency: 'CAD', finalCategory: 'Hobbies / Travel', spent: 20.23 },
  { currency: 'CAD', finalCategory: 'Hosting', spent: 44.76 },
  { currency: 'CAD', finalCategory: 'Household', spent: 793.68 },
  { currency: 'CAD', finalCategory: 'Household / Vape', spent: 265.48 },
  { currency: 'CAD', finalCategory: 'Internet', spent: 203.34 },
  { currency: 'CAD', finalCategory: 'Rent', spent: 2906.72 },
  { currency: 'CAD', finalCategory: 'Spotify', spent: 15.81 },
  { currency: 'CAD', finalCategory: 'Subscriptions', spent: 3.38 },
  { currency: 'CAD', finalCategory: 'Transportation', spent: 27.92 },
  { currency: 'CAD', finalCategory: 'Transportation / Gas', spent: 3.49 },
];
```

- [ ] **Step 2: Write the failing test**

`backend/src/categories/mergePlan.budgetInvariance.test.ts`. It asserts `spent`, never `percentUsed`, so editing a budget's amount in prod does not churn it.

The spend map key is the same one `routes/budgets.ts:575` builds: the currency, a NUL character, then the raw category string. Write that NUL as the escape `\0` inside a template literal.

```ts
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
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/categories/mergePlan.budgetInvariance.test.ts
```

Expected: FAIL — `Cannot find module '../../lib/categoryMergePlan'`.

- [ ] **Step 4: Write the planner**

`backend/lib/categoryMergePlan.js`:

```js
'use strict';

/**
 * Plan the merge of duplicate (household_id, name_key) category groups.
 * Pure: plain rows in, a plan out. No DB, no Sequelize. Shared by
 * src/migrations/20260930000001-merge-duplicate-category-names.js and by
 * src/categories/mergePlan.budgetInvariance.test.ts so the migration's
 * behaviour is exactly what the golden test proves.
 */

/** Names of a category and every descendant, over a flat row list. */
function subtreeNames(categories, rootId) {
  const childrenByParent = new Map();
  const nameById = new Map();
  for (const c of categories) {
    nameById.set(c.id, c.name);
    if (c.parentId == null) continue;
    const list = childrenByParent.get(c.parentId) || [];
    list.push(c.id);
    childrenByParent.set(c.parentId, list);
  }
  const names = new Set();
  const seen = new Set();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    if (nameById.has(id)) names.add(nameById.get(id));
    for (const child of childrenByParent.get(id) || []) stack.push(child);
  }
  return names;
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * @param {Array<{id:number, householdId:number, parentId:number|null, name:string, nameKey:string}>} categories
 * @param {Record<number, number>|Map<number, number>} refCounts total references per category id
 * @param {Array<{id:number, categoryId:number|null}>} budgets
 * @returns {{merges: Array, reparents: Array, budgetActions: Array}}
 */
function planCategoryMerges(categories, refCounts, budgets) {
  const refOf = (id) => {
    const n = refCounts instanceof Map ? refCounts.get(id) : refCounts[id];
    return typeof n === 'number' ? n : 0;
  };

  const groups = new Map();
  for (const c of categories) {
    const key = `${c.householdId} ${c.nameKey}`;
    const list = groups.get(key) || [];
    list.push(c);
    groups.set(key, list);
  }

  const merges = [];
  const reparents = [];
  for (const [, members] of groups) {
    if (members.length < 2) continue;
    // Rule W: most references wins; ties break to the lowest (oldest) id.
    const winner = members.slice().sort((a, b) => refOf(b.id) - refOf(a.id) || a.id - b.id)[0];
    for (const loser of members) {
      if (loser.id === winner.id) continue;
      merges.push({
        householdId: loser.householdId, nameKey: loser.nameKey,
        winnerId: winner.id, loserId: loser.id,
      });
      for (const child of categories) {
        if (child.parentId === loser.id) reparents.push({ childId: child.id, newParentId: winner.id });
      }
    }
  }

  // The post-merge shape, so Rule B compares against what the budget WILL count.
  const losers = new Set(merges.map((m) => m.loserId));
  const reparentTo = new Map(reparents.map((r) => [r.childId, r.newParentId]));
  const after = categories
    .filter((c) => !losers.has(c.id))
    .map((c) => (reparentTo.has(c.id) ? Object.assign({}, c, { parentId: reparentTo.get(c.id) }) : c));

  const winnerByLoser = new Map(merges.map((m) => [m.loserId, m.winnerId]));
  const budgetActions = [];
  for (const b of budgets) {
    if (b.categoryId == null || !winnerByLoser.has(b.categoryId)) continue;
    const winnerId = winnerByLoser.get(b.categoryId);
    // Rule B: a merge must never widen what a budget counts. If the name set
    // would change, detach (category_id = NULL, name string retained) — the
    // exact-match no-rollup form budgets 'Household' and 'Hobbies' already use.
    const widens = !sameSet(subtreeNames(categories, b.categoryId), subtreeNames(after, winnerId));
    budgetActions.push(
      widens
        ? { budgetId: b.id, action: 'detach', categoryId: null }
        : { budgetId: b.id, action: 'repoint', categoryId: winnerId },
    );
  }

  return { merges, reparents, budgetActions };
}

module.exports = { planCategoryMerges, subtreeNames };
```

`backend/lib/categoryMergePlan.d.ts`:

```ts
export interface PlanCategory {
  id: number; householdId: number; parentId: number | null; name: string; nameKey: string;
}
export interface PlanBudget { id: number; categoryId: number | null }
export interface Merge { householdId: number; nameKey: string; winnerId: number; loserId: number }
export interface Reparent { childId: number; newParentId: number }
export interface BudgetAction {
  budgetId: number; action: 'repoint' | 'detach'; categoryId: number | null;
}
export interface MergePlan { merges: Merge[]; reparents: Reparent[]; budgetActions: BudgetAction[] }

export function planCategoryMerges(
  categories: PlanCategory[],
  refCounts: Record<number, number> | Map<number, number>,
  budgets: PlanBudget[],
): MergePlan;

export function subtreeNames(categories: PlanCategory[], rootId: number): Set<string>;
```

`backend/src/categories/mergePlan.ts` — the typed facade, exactly the shape of
`src/import/normalizeMerchant.ts`:

```ts
/**
 * Typed facade over `backend/lib/categoryMergePlan.js`.
 *
 * The implementation is plain CommonJS outside `src/` because the migration
 * needs the identical function and `sequelize-cli` loads migrations as plain JS
 * with no TypeScript pipeline. `src/categories/` and `dist/categories/` sit at
 * the same depth under `backend/`, so this one relative path resolves the same
 * way from the source tree, the build output, and `src/migrations/`.
 */
import categoryMergePlan = require('../../lib/categoryMergePlan');

export const planCategoryMerges = categoryMergePlan.planCategoryMerges;
export const subtreeNames = categoryMergePlan.subtreeNames;
export type {
  PlanCategory, PlanBudget, Merge, Reparent, BudgetAction, MergePlan,
} from '../../lib/categoryMergePlan';
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/categories/mergePlan.budgetInvariance.test.ts
```

Expected: PASS, 5 tests.

If **"the merge alone changes no budget spend at all"** fails, STOP and report. Do not edit the expected values to make it green — that test failing means the merge is not safe and the design is wrong.

- [ ] **Step 6: Commit**

```bash
git add backend/lib/categoryMergePlan.js backend/lib/categoryMergePlan.d.ts \
        backend/src/categories/mergePlan.ts \
        backend/src/categories/mergePlanFixture.ts \
        backend/src/categories/mergePlan.budgetInvariance.test.ts
git commit -m "test(categories): pin budget spend across the duplicate-category merge"
```

---

### Task 2: `resolveCategoryPath` resolves names household-globally

**Files:**
- Modify: `backend/src/categories/resolvePath.ts:13-20` and its `run` loop at `:33-52`
- Test: `backend/src/categories/resolvePath.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `resolveCategoryPath` keeps its signature — `(householdId: number, input: string, opts?: { transaction?: Transaction }) => Promise<{ leafId: number; createdIds: number[] }>`. Task 3 depends on `leafId` now pointing at a pre-existing node whenever the name exists anywhere in the household.

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/categories/resolvePath.test.ts`:

```ts
test('a bare name reuses a nested node instead of forking a root', async () => {
  // The exact prod shape: Subscriptions / Ai exists, and the AI returns "Ai".
  const subs = await Category.create({ householdId, name: 'Subscriptions', parentId: null });
  const ai = await Category.create({ householdId, name: 'Ai', parentId: subs.id });
  const { leafId, createdIds } = await resolveCategoryPath(householdId, 'Ai');
  assert.equal(leafId, ai.id);
  assert.equal(createdIds.length, 0);
  assert.equal(await Category.count({ where: { householdId } }), 2);
});

test('a path whose leaf lives under a different parent reuses it, and does not reparent it', async () => {
  const house = await Category.create({ householdId, name: 'Household', parentId: null });
  const groceries = await Category.create({ householdId, name: 'Groceries', parentId: house.id });
  const { leafId, createdIds } = await resolveCategoryPath(householdId, 'Food / Groceries');
  assert.equal(leafId, groceries.id);
  const food = await Category.findOne({ where: { householdId, nameKey: 'food' } });
  assert.deepEqual(createdIds, [food!.id], 'only the missing "Food" segment is created');
  await groceries.reload();
  assert.equal(groceries.parentId, house.id, 'the hint must not move an existing node');
});

test('a name absent from the household is still created at the walk position', async () => {
  const { leafId, createdIds } = await resolveCategoryPath(householdId, 'Work / Internet');
  assert.equal(createdIds.length, 2);
  const leaf = await Category.findByPk(leafId);
  assert.equal(leaf?.name, 'Internet');
  assert.equal((await Category.findByPk(leaf!.parentId!))?.name, 'Work');
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/categories/resolvePath.test.ts
```

Expected: the first two FAIL — `resolveCategoryPath` creates a second `Ai` root and a second `Groceries`, so `leafId` is a new id and `createdIds.length` is 1.

The pre-existing test `'bare name resolves to a root node'` still passes: in an empty household `Groceries` exists nowhere, so it is created at the root.

- [ ] **Step 3: Implement**

Replace `findSibling` in `backend/src/categories/resolvePath.ts`:

```ts
/**
 * Find an existing node for this name ANYWHERE in the household.
 *
 * Category names are unique per household (categories_household_name_key_unique),
 * so a path is a hint about where a NEW category belongs, not an address: if the
 * name already exists the walk reuses that node whatever its parent, and never
 * reparents it. Resolving parent-scoped is what let the nightly enrichment job
 * fork 15 categories into duplicate roots on 2026-09-29 — see
 * docs/superpowers/specs/2026-09-30-cashflow-duplicate-categories-design.md.
 */
async function findByName(
  householdId: number,
  nameKey: string,
  transaction: Transaction,
): Promise<Category | null> {
  return Category.findOne({ where: { householdId, nameKey }, transaction });
}
```

and the loop inside `run`:

```ts
    for (const segment of segments) {
      const nameKey = normalizeCategoryName(segment);
      let node = await findByName(householdId, nameKey, transaction);
      if (!node) {
        try {
          node = await Category.create(
            { householdId, parentId, name: segment, icon: null },
            { transaction },
          );
          createdIds.push(node.id);
        } catch (err) {
          if (err instanceof UniqueConstraintError) {
            node = await findByName(householdId, nameKey, transaction);
          }
          if (!node) throw err;
        }
      }
      parentId = node.id;
      leafId = node.id;
    }
```

- [ ] **Step 4: Run to verify they pass**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/categories/resolvePath.test.ts
```

Expected: PASS, all tests including the five pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add backend/src/categories/resolvePath.ts backend/src/categories/resolvePath.test.ts
git commit -m "fix(categories): resolve path segments household-globally so a flat name cannot fork a root"
```

---

### Task 3: `ensureCategory` returns the resolved leaf

**Files:**
- Modify: `backend/src/util/ensureCategory.ts`
- Test: `backend/src/util/ensureCategory.test.ts` (create)

**Interfaces:**
- Consumes: `resolveCategoryPath` from Task 2.
- Produces: `ensureCategory(householdId: number, name: string | null | undefined, options?: { transaction?: SequelizeTransaction | null }) => Promise<EnsuredCategory | null>` where `EnsuredCategory` is `{ id: number; name: string }`. Returns `null` for a null/empty name or a malformed path. Task 4 consumes this return value.

- [ ] **Step 1: Write the failing test**

`backend/src/util/ensureCategory.test.ts`:

```ts
// backend/src/util/ensureCategory.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Category, Household } from '../models';
import { ensureCategory } from './ensureCategory';

let householdId: number;

beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
});

test('returns the leaf id and its FLAT name for a path', async () => {
  const leaf = await ensureCategory(householdId, 'Household / Rent');
  assert.ok(leaf);
  assert.equal(leaf!.name, 'Rent', 'the caller writes this into final_category, so it must be flat');
  assert.equal((await Category.findByPk(leaf!.id))?.name, 'Rent');
});

test('returns the existing node for a flat name already nested elsewhere', async () => {
  const subs = await Category.create({ householdId, name: 'Subscriptions', parentId: null });
  const ai = await Category.create({ householdId, name: 'Ai', parentId: subs.id });
  const leaf = await ensureCategory(householdId, 'Ai');
  assert.equal(leaf?.id, ai.id);
  assert.equal(leaf?.name, 'Ai');
});

test('returns null for an empty name and for a malformed path', async () => {
  assert.equal(await ensureCategory(householdId, null), null);
  assert.equal(await ensureCategory(householdId, '   '), null);
  assert.equal(await ensureCategory(householdId, 'Work//Internet'), null);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/util/ensureCategory.test.ts
```

Expected: FAIL — `ensureCategory` resolves to `undefined`, so `assert.ok(leaf)` fails.

- [ ] **Step 3: Implement**

Replace `backend/src/util/ensureCategory.ts` entirely:

```ts
import type { Transaction as SequelizeTransaction } from 'sequelize';
import { Category } from '../models/Category';
import { resolveCategoryPath } from '../categories/resolvePath';

/**
 * The category a free-text enrichment value resolved to. `name` is the leaf's
 * FLAT name — callers write it into `final_category` / `auto_category`, which
 * every spend rollup joins on as an exact string, so it must never be a path.
 */
export interface EnsuredCategory {
  id: number;
  name: string;
}

/**
 * Ensure a category exists for a free-text `name` (e.g. an enrichment
 * `autoCategory`) and return it. Null for a null / empty / whitespace-only name.
 *
 * Routes through {@link resolveCategoryPath} so a `"Parent / Child"` value
 * resolves to the existing `Child` node wherever it lives, rather than being
 * written verbatim as a flat top-level row. A malformed path (empty segment) is
 * swallowed and returns null — enrichment is fire-and-forget and a bad mirror
 * name must not fail the batch.
 *
 * Pass `options.transaction` to participate in the caller's transaction —
 * required when called from a Sequelize `afterSave` hook so an outer rollback
 * also rolls back the category insert.
 */
export async function ensureCategory(
  householdId: number,
  name: string | null | undefined,
  options: { transaction?: SequelizeTransaction | null } = {}
): Promise<EnsuredCategory | null> {
  if (name == null) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  const transaction = options.transaction ?? undefined;
  try {
    const { leafId } = await resolveCategoryPath(householdId, trimmed, { transaction });
    const leaf = await Category.findByPk(leafId, { transaction });
    return leaf ? { id: leaf.id, name: leaf.name } : null;
  } catch (err) {
    if (err instanceof Error && err.message === 'invalid category path') return null;
    throw err;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/util/ensureCategory.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Typecheck for broken callers**

```bash
yarn workspace cashflow-backend run typecheck
```

Expected: PASS. The return type widened from `void`; callers that ignore it still compile.

- [ ] **Step 6: Commit**

```bash
git add backend/src/util/ensureCategory.ts backend/src/util/ensureCategory.test.ts
git commit -m "feat(categories): ensureCategory returns the resolved leaf id and flat name"
```

---

### Task 4: The AI writers persist the category id and a flat name

**Files:**
- Modify: `backend/src/import/enrichment/aiBatchOverColdRows.ts:136-195`
- Modify: `backend/src/import/enrichment/embeddingMatchOverColdRows.ts:99-162`
- Modify: `backend/src/amazon/aiCategorizeAmazonItems.ts:336-355`
- Test: `backend/src/import/enrichment/aiBatchOverColdRows.test.ts`

**Interfaces:**
- Consumes: `ensureCategory(...) => Promise<EnsuredCategory | null>` from Task 3.
- Produces: `applyAmazonItemCategorySuggestions(suggestions, householdId)` gains a second parameter. Nothing else downstream.

- [ ] **Step 1: Write the failing test**

Append to `backend/src/import/enrichment/aiBatchOverColdRows.test.ts`, following that file's existing setup helpers. If it has no helper that builds a persisted household + transaction, add a `beforeEach` in the shape of `resolvePath.test.ts`'s.

```ts
test('persistAiEnhancement writes a flat name and the category id, never a path', async () => {
  const household = await Household.create({ name: 'T' });
  const houseRoot = await Category.create({
    householdId: household.id, name: 'Household', parentId: null,
  });
  const rent = await Category.create({
    householdId: household.id, name: 'Rent', parentId: houseRoot.id,
  });
  const txn = await Transaction.create({
    householdId: household.id, date: '2026-09-01', amount: '-100', currency: 'CAD',
    merchantRaw: 'LANDLORD',
  });

  // The model echoes back a hint from loadCategoryHints, which is path-form.
  await persistAiEnhancement(
    coldRowFor(txn),
    { confidence: 0.9, fields: { autoCategory: 'Household / Rent' } } as Signal,
    household.id,
  );

  await txn.reload();
  assert.equal(txn.finalCategory, 'Rent', 'the path form must never reach final_category');
  assert.equal(txn.finalCategoryId, rent.id);
  assert.equal(txn.autoCategory, 'Rent');
  assert.equal(txn.autoCategoryId, rent.id);
  assert.equal(
    await Category.count({ where: { householdId: household.id } }), 2,
    'no new category is created',
  );
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/import/enrichment/aiBatchOverColdRows.test.ts
```

Expected: FAIL — `txn.finalCategory` is `'Household / Rent'` and `txn.finalCategoryId` is `null`.

- [ ] **Step 3: Implement in `aiBatchOverColdRows.ts`**

In `persistAiEnhancement`, replace the whole `try` block body up to and including the trailing `ensureCategory` call:

```ts
  try {
    // Resolve BEFORE the write. A static update bypasses the beforeSave
    // category-id hook, so the ids have to be supplied explicitly — and the
    // string mirrors have to be the resolved node's FLAT name, because
    // loadCategoryHints feeds the model path-form hints it echoes back, and
    // every spend rollup joins final_category as an exact string.
    const { ensureCategory } = await import('../../util/ensureCategory');
    const autoLeaf = householdId == null
      ? null : await ensureCategory(householdId, merged.fields.autoCategory);
    const finalLeaf = householdId == null
      ? null : await ensureCategory(householdId, finalCategory);

    await Transaction.update(
      {
        autoCategory: autoLeaf?.name ?? merged.fields.autoCategory,
        autoCategoryId: autoLeaf?.id ?? null,
        finalCategory: finalLeaf?.name ?? finalCategory,
        finalCategoryId: finalLeaf?.id ?? null,
        autoBusiness: merged.fields.autoBusiness,
        autoSplitType: merged.fields.autoSplitType,
        autoPctMe: merged.fields.autoPctMe,
        autoPctPartner: merged.fields.autoPctPartner,
        autoSource: merged.fields.autoSource,
        autoConfidence: merged.fields.autoConfidence,
        reviewFlag: merged.fields.reviewFlag,
        importConfidence: confidence.state,
        importConfidenceFlags: serializeFlags(confidence.flags),
      },
      { where: { id: c.txnId } },
    );
    await TransactionSignal.create({
      transactionId: c.txnId,
      source: 'ai',
      confidence: aiSignal.confidence,
      fields: aiSignal.fields,
      rationale: aiSignal.rationale ?? null,
    });
    return true;
```

Delete the old `NOTE:` comment above the update. Its claim that migration `20260623000001` backfills null FKs is false — that migration is one-shot and ran in June 2026, which is why ~2,800 rows accumulated a NULL `final_category_id`.

- [ ] **Step 4: Apply the identical shape to `embeddingMatchOverColdRows.ts`**

Same edit in its persist function, leaving `source: 'embedding'` on the `TransactionSignal.create` unchanged. Delete its four-line `NOTE:` comment and its trailing `ensureCategory` block.

- [ ] **Step 5: Apply to `aiCategorizeAmazonItems.ts`**

`applyAmazonItemCategorySuggestions` has no `ensureCategory` call at all. It needs a household to resolve against, so take one:

```ts
export async function applyAmazonItemCategorySuggestions(
  suggestions: AmazonItemCategorySuggestion[],
  householdId: number | null,
): Promise<number> {
  const { ensureCategory } = await import('../util/ensureCategory');
  let updated = 0;
  for (const suggestion of suggestions) {
    // Static update bypasses the beforeSave hook, so resolve the id here and
    // store the leaf's flat name — same shape as aiBatchOverColdRows.
    const leaf = householdId == null ? null : await ensureCategory(householdId, suggestion.category);
    const [count] = await ExternalOrderItem.update(
      {
        inferredCategory: leaf?.name ?? suggestion.category,
        inferredCategoryId: leaf?.id ?? null,
        businessUsePercent:
          suggestion.businessUsePercent == null
            ? null
            : String(suggestion.businessUsePercent),
        confidence: String(suggestion.confidence),
      },
      { where: { id: suggestion.itemId } },
    );
    updated += count;
  }
  return updated;
}
```

Update every call site the typecheck flags to pass the household id already in its scope.

- [ ] **Step 6: Run the enrichment tests and the typecheck**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/import/enrichment/aiBatchOverColdRows.test.ts src/import/enrichment/embeddingMatchOverColdRows.test.ts
```
Expected: PASS.

```bash
yarn workspace cashflow-backend run typecheck
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/import/enrichment/aiBatchOverColdRows.ts \
        backend/src/import/enrichment/embeddingMatchOverColdRows.ts \
        backend/src/amazon/aiCategorizeAmazonItems.ts \
        backend/src/import/enrichment/aiBatchOverColdRows.test.ts
git commit -m "fix(enrichment): persist the resolved category id and a flat name from the AI writers"
```

---

### Task 5: Conflict checks go household-global

**Files:**
- Modify: `backend/src/categories/errors.ts:1-8`
- Modify: `backend/src/categories/createCategory.ts:15-22`
- Modify: `backend/src/categories/reparent.ts:22-35`
- Modify: `backend/src/routes/categories.ts:171-177`
- Test: `backend/src/categories/createCategory.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CategoryErrorCode` gains `'name_conflict'`. `statusForCategoryError` (`routes/categories.ts:25-29`) already returns 409 for any code it does not special-case, so it needs no change.

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/categories/createCategory.test.ts`:

```ts
test('rejects a name that exists anywhere in the household, not just as a sibling', async () => {
  const subs = await Category.create({ householdId, name: 'Subscriptions', parentId: null });
  await Category.create({ householdId, name: 'Ai', parentId: subs.id });
  await assert.rejects(
    () => createCategory(householdId, 'Ai', null),
    (e: CategoryError) => e.code === 'name_conflict',
  );
});

test('rejects a nested name that collides with an existing root', async () => {
  const house = await Category.create({ householdId, name: 'Household', parentId: null });
  await Category.create({ householdId, name: 'Office Equipment', parentId: null });
  await assert.rejects(
    () => createCategory(householdId, 'Office Equipment', house.id),
    (e: CategoryError) => e.code === 'name_conflict',
  );
});

test('the same name in a different household is still fine', async () => {
  const other = (await Household.create({ name: 'Other' })).id;
  await Category.create({ householdId, name: 'Golf', parentId: null });
  const row = await createCategory(other, 'Golf', null);
  assert.equal(row.name, 'Golf');
});
```

Add `Household` to the file's model imports if it is not already there.

- [ ] **Step 2: Run to verify they fail**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/categories/createCategory.test.ts
```

Expected: the first two FAIL — the conflict check is scoped to `parentId`, so both creations currently succeed.

- [ ] **Step 3: Add the error code**

`backend/src/categories/errors.ts`:

```ts
export type CategoryErrorCode =
  | 'not_found'
  | 'parent_not_found'
  | 'cycle'
  | 'sibling_conflict'
  | 'name_conflict'
  | 'has_children'
  | 'has_references'
  | 'invalid_name';
```

`sibling_conflict` stays in the union: removing it would be a breaking API change for any client matching on it, and it costs nothing to keep.

- [ ] **Step 4: Widen the three lookups**

`backend/src/categories/createCategory.ts` — drop `parentId` from the conflict `where`:

```ts
  const nameKey = normalizeCategoryName(name.trim());
  // Category names are unique per HOUSEHOLD, not per parent
  // (categories_household_name_key_unique): budgets and spend rollups join on
  // the name string, so two same-named nodes anywhere are indistinguishable
  // downstream.
  const conflict = await Category.findOne({ where: { householdId, nameKey } });
  if (conflict) {
    throw new CategoryError(
      'name_conflict',
      `a category named "${name.trim()}" already exists in this household`,
    );
  }
```

`backend/src/categories/reparent.ts:22-35` — drop `parentId` from its conflict `where` and change the thrown code to `'name_conflict'`, with the message `a category named "${node.name}" already exists in this household`. This check can now only fire on a data inconsistency, since a moved node keeps its own name and the index already forbids a household-wide duplicate; keep it as a guard.

`backend/src/routes/categories.ts:171-177`:

```ts
      const conflict = await Category.findOne({
        where: { householdId: row.householdId, nameKey: newKey, id: { [Op.ne]: row.id } },
      });
      if (conflict) {
        res.status(409).json({
          error: `a category named "${newName}" already exists in this household`,
          code: 'name_conflict',
        });
        return;
      }
```

- [ ] **Step 5: Run the affected tests**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/categories/createCategory.test.ts src/categories/reparent.test.ts src/routes/categories.test.ts
```

Expected: PASS. Any pre-existing test asserting `sibling_conflict` from these three paths must be updated to `name_conflict` — that is the intended contract change, not a test to work around.

- [ ] **Step 6: Commit**

```bash
git add backend/src/categories/errors.ts backend/src/categories/createCategory.ts \
        backend/src/categories/reparent.ts backend/src/routes/categories.ts \
        backend/src/categories/createCategory.test.ts backend/src/categories/reparent.test.ts \
        backend/src/routes/categories.test.ts
git commit -m "feat(categories): category names are unique per household, not per parent"
```

---

### Task 6: Migration — merge the duplicates, then swap the indexes

**Files:**
- Create: `backend/src/migrations/20260930000001-merge-duplicate-category-names.js`
- Modify: `backend/src/models/Category.ts:67-80`
- Test: `backend/src/migrations/__tests__/mergeDuplicateCategoryNamesMigration.test.ts`

**Interfaces:**
- Consumes: `planCategoryMerges` from Task 1 via `require('../../lib/categoryMergePlan')`.
- Produces: the `categories_household_name_key_unique` index that Task 2's comment and Task 5's checks assume.

Read `backend/src/migrations/20260621000001-category-tree-foundation.js` first — this migration mirrors its guard and index style, and its `down` restores the two partial indexes that one created.

- [ ] **Step 1: Write the failing test**

`backend/src/migrations/__tests__/mergeDuplicateCategoryNamesMigration.test.ts`, in the shape of the sibling `categoryTreeFoundationMigration.test.ts`: an in-memory SQLite DB, stub tables carrying only the columns the migration reads, and `require` of the migration file. Tests run in order against the one DB, so `up()` runs once in the first test and later tests assert on its result.

```ts
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...a: any[]) => Promise<void>; down: (...a: any[]) => Promise<void> };

/** Only the columns 20260930000001 actually reads. */
async function buildSchema(qi: ReturnType<Sequelize['getQueryInterface']>) {
  await qi.createTable('categories', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    parent_id: { type: DataTypes.INTEGER, allowNull: true },
    name: { type: DataTypes.STRING(128), allowNull: false },
    name_key: { type: DataTypes.STRING(128), allowNull: false },
  });
  await qi.addIndex('categories', ['household_id', 'parent_id', 'name_key'], {
    name: 'categories_household_parent_name_key_unique',
    unique: true,
    where: { parent_id: { [Sequelize.Op.ne]: null } },
  });
  await qi.addIndex('categories', ['household_id', 'name_key'], {
    name: 'categories_household_root_name_key_unique',
    unique: true,
    where: { parent_id: null },
  });
  await qi.createTable('transactions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    final_category_id: { type: DataTypes.INTEGER, allowNull: true },
    auto_category_id: { type: DataTypes.INTEGER, allowNull: true },
    category_override_id: { type: DataTypes.INTEGER, allowNull: true },
  });
  await qi.createTable('budget_targets', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    category: { type: DataTypes.STRING(128), allowNull: true },
    category_id: { type: DataTypes.INTEGER, allowNull: true },
  });
  for (const table of ['rules', 'income_entries']) {
    await qi.createTable(table, {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      category_id: { type: DataTypes.INTEGER, allowNull: true },
    });
  }
  await qi.createTable('external_order_items', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    inferred_category_id: { type: DataTypes.INTEGER, allowNull: true },
    category_override_id: { type: DataTypes.INTEGER, allowNull: true },
  });
}

// The prod shape in miniature. Ids are explicit so the assertions can name them.
// 10 Subscriptions > 11 Ai, and a stray root 12 Ai        -> 11 wins (more refs)
// 20 Hobbies > 21 Golf > 22 Clublink, and a root 23 Golf  -> 21 wins, budget DETACHES
// 30 Household > 31 Groceries, and a root 32 Groceries    -> 31 wins, budget REPOINTS
// 40 Legacy (root, 0 refs) with child 41 Desk, and root 42 Legacy (2 refs) -> 42 wins, 41 moves
const CATS = [
  { id: 10, household_id: 1, parent_id: null, name: 'Subscriptions', name_key: 'subscriptions' },
  { id: 11, household_id: 1, parent_id: 10, name: 'Ai', name_key: 'ai' },
  { id: 12, household_id: 1, parent_id: null, name: 'Ai', name_key: 'ai' },
  { id: 20, household_id: 1, parent_id: null, name: 'Hobbies', name_key: 'hobbies' },
  { id: 21, household_id: 1, parent_id: 20, name: 'Golf', name_key: 'golf' },
  { id: 22, household_id: 1, parent_id: 21, name: 'Clublink', name_key: 'clublink' },
  { id: 23, household_id: 1, parent_id: null, name: 'Golf', name_key: 'golf' },
  { id: 30, household_id: 1, parent_id: null, name: 'Household', name_key: 'household' },
  { id: 31, household_id: 1, parent_id: 30, name: 'Groceries', name_key: 'groceries' },
  { id: 32, household_id: 1, parent_id: null, name: 'Groceries', name_key: 'groceries' },
  { id: 40, household_id: 1, parent_id: null, name: 'Legacy', name_key: 'legacy' },
  { id: 41, household_id: 1, parent_id: 40, name: 'Desk', name_key: 'desk' },
  { id: 42, household_id: 2, parent_id: null, name: 'Golf', name_key: 'golf' },
];

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  await buildSchema(qi);
  await qi.bulkInsert('categories', CATS);
  // Ai: 5 refs on the nested 11, 1 on the stray root 12.
  await qi.bulkInsert('transactions', [
    ...Array.from({ length: 5 }, () => ({ final_category_id: 11 })),
    { final_category_id: 12, auto_category_id: 12, category_override_id: 12 },
    // Golf: nested 21 carries history, root 23 carries none.
    ...Array.from({ length: 4 }, () => ({ final_category_id: 21 })),
    // Groceries: nested 31 carries history.
    ...Array.from({ length: 3 }, () => ({ final_category_id: 31 })),
    // Legacy: root 40 has a child but no refs; there is no second Legacy in
    // household 1, so 40 is not part of any duplicate group. See the reparent
    // test, which adds one.
  ]);
  await qi.bulkInsert('rules', [{ category_id: 12 }]);
  await qi.bulkInsert('income_entries', [{ category_id: 11 }]);
  await qi.bulkInsert('external_order_items', [{ inferred_category_id: 11, category_override_id: 12 }]);
  await qi.bulkInsert('budget_targets', [
    { id: 1, category: 'Golf', category_id: 23 },       // winner 21 has Clublink -> detach
    { id: 2, category: 'Groceries', category_id: 32 },  // winner 31 is childless -> repoint
    { id: 3, category: 'Clublink', category_id: 22 },   // untouched
  ]);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260930000001-merge-duplicate-category-names.js');
  await migration.up(qi, Sequelize);
});

after(async () => { await sequelize.close(); });

async function rows<T>(q: string): Promise<T[]> {
  const [r] = await sequelize.query(q);
  return r as T[];
}

test('merges a nested duplicate into the reference-heavy node and repoints every column', async () => {
  assert.deepEqual(await rows("SELECT id FROM categories WHERE id = 12"), []);
  const counts = await rows<{ n: number }>(
    'SELECT COUNT(*) AS n FROM transactions WHERE final_category_id = 11',
  );
  assert.equal(counts[0].n, 6, 'the stray root’s transaction moved onto the nested node');
  assert.deepEqual(
    await rows<{ auto_category_id: number; category_override_id: number }>(
      'SELECT auto_category_id, category_override_id FROM transactions WHERE auto_category_id IS NOT NULL',
    ),
    [{ auto_category_id: 11, category_override_id: 11 }],
  );
  assert.deepEqual(await rows('SELECT category_id FROM rules'), [{ category_id: 11 }]);
  assert.deepEqual(
    await rows('SELECT inferred_category_id, category_override_id FROM external_order_items'),
    [{ inferred_category_id: 11, category_override_id: 11 }],
  );
});

test('detaches a budget whose winner would widen what it counts', async () => {
  const [budget] = await rows<{ category: string; category_id: number | null }>(
    'SELECT category, category_id FROM budget_targets WHERE id = 1',
  );
  assert.equal(budget.category_id, null, 'winner 21 rolls up Clublink, so the id must be dropped');
  assert.equal(budget.category, 'Golf', 'the name string is the exact-match key and must survive');
});

test('repoints a budget whose winner counts exactly the same names', async () => {
  const [budget] = await rows<{ category: string; category_id: number | null }>(
    'SELECT category, category_id FROM budget_targets WHERE id = 2',
  );
  assert.equal(budget.category_id, 31, 'both nodes are childless, so the name set is unchanged');
  assert.equal(budget.category, 'Groceries');
});

test('a household-2 category with the same name is untouched', async () => {
  const [row] = await rows<{ parent_id: number | null }>(
    'SELECT parent_id FROM categories WHERE id = 42',
  );
  assert.equal(row.parent_id, null, 'duplicate groups are scoped per household');
});

test('the global unique index exists and both partials are gone', async () => {
  const idx = await sequelize.getQueryInterface().showIndex('categories');
  const names = idx.map((i) => i.name);
  assert.ok(names.includes('categories_household_name_key_unique'));
  assert.ok(!names.includes('categories_household_parent_name_key_unique'));
  assert.ok(!names.includes('categories_household_root_name_key_unique'));
  await assert.rejects(
    () => sequelize.query(
      "INSERT INTO categories (household_id, parent_id, name, name_key) VALUES (1, 20, 'Groceries', 'groceries')",
    ),
    /UNIQUE|constraint/i,
    'a nested duplicate of an existing name must now be rejected',
  );
});

test('running up() again is a no-op and does not throw on the index swap', async () => {
  const before_ = await rows('SELECT id FROM categories ORDER BY id');
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  assert.deepEqual(await rows('SELECT id FROM categories ORDER BY id'), before_);
});

test('moves a loser’s children onto the winner before deleting it', async () => {
  // A fresh DB: household 1 has root 40 Legacy (child 41 Desk, no refs) and
  // root 42 Legacy (2 refs). 42 wins by Rule W, so 41 must survive under 42 --
  // categories_parent_id_fkey is ON DELETE RESTRICT in the real schema.
  const db = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = db.getQueryInterface();
  await buildSchema(qi);
  await qi.bulkInsert('categories', [
    { id: 40, household_id: 1, parent_id: null, name: 'Legacy', name_key: 'legacy' },
    { id: 41, household_id: 1, parent_id: 40, name: 'Desk', name_key: 'desk' },
  ]);
  // 42 must be nested to coexist with root 40 under the OLD partial indexes.
  await qi.bulkInsert('categories', [
    { id: 43, household_id: 1, parent_id: null, name: 'Archive', name_key: 'archive' },
    { id: 42, household_id: 1, parent_id: 43, name: 'Legacy', name_key: 'legacy' },
  ]);
  await qi.bulkInsert('transactions', [{ final_category_id: 42 }, { final_category_id: 42 }]);
  await migration.up(qi, Sequelize);

  const [r] = await db.query('SELECT id, parent_id FROM categories WHERE id IN (40, 41, 42) ORDER BY id');
  assert.deepEqual(r, [{ id: 41, parent_id: 42 }, { id: 42, parent_id: 43 }],
    'loser 40 is gone and its child now hangs off winner 42');
  await db.close();
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/migrations/__tests__/mergeDuplicateCategoryNamesMigration.test.ts
```

Expected: FAIL — the migration file does not exist.

- [ ] **Step 3: Write the migration**

`backend/src/migrations/20260930000001-merge-duplicate-category-names.js`:

```js
'use strict';

// Merge duplicate (household_id, name_key) categories, then replace the two
// partial unique indexes with one household-wide unique. The nightly
// enrichment job forked 15 categories in household 1 on 2026-09-29 because
// resolveCategoryPath looked names up parent-scoped; see
// docs/superpowers/specs/2026-09-30-cashflow-duplicate-categories-design.md.
//
// The winner/loser and budget decisions come from lib/categoryMergePlan.js, the
// same pure function src/categories/mergePlan.budgetInvariance.test.ts proves
// leaves every budget's spend unchanged.
const { planCategoryMerges } = require('../../lib/categoryMergePlan');

/** Every column that points at categories.id. */
const REFS = [
  ['transactions', 'final_category_id'],
  ['transactions', 'auto_category_id'],
  ['transactions', 'category_override_id'],
  ['rules', 'category_id'],
  ['budget_targets', 'category_id'],
  ['income_entries', 'category_id'],
  ['external_order_items', 'inferred_category_id'],
  ['external_order_items', 'category_override_id'],
];

module.exports = {
  async up(queryInterface) {
    const sql = queryInterface.sequelize;

    const [categories] = await sql.query(
      'SELECT id, household_id, parent_id, name, name_key FROM categories',
    );
    const rows = categories.map((c) => ({
      id: c.id, householdId: c.household_id, parentId: c.parent_id,
      name: c.name, nameKey: c.name_key,
    }));

    const refCounts = {};
    for (const [table, column] of REFS) {
      const [counts] = await sql.query(
        `SELECT ${column} AS id, COUNT(*) AS n FROM ${table} ` +
        `WHERE ${column} IS NOT NULL GROUP BY ${column}`,
      );
      for (const r of counts) refCounts[r.id] = (refCounts[r.id] || 0) + Number(r.n);
    }

    const [budgets] = await sql.query('SELECT id, category_id FROM budget_targets');
    const plan = planCategoryMerges(
      rows, refCounts, budgets.map((b) => ({ id: b.id, categoryId: b.category_id })),
    );

    // 1. Children first — categories_parent_id_fkey is ON DELETE RESTRICT.
    for (const r of plan.reparents) {
      await sql.query('UPDATE categories SET parent_id = :p WHERE id = :id', {
        replacements: { p: r.newParentId, id: r.childId },
      });
    }

    // 2. Repoint every non-budget reference, then delete the loser.
    for (const m of plan.merges) {
      for (const [table, column] of REFS) {
        if (table === 'budget_targets') continue; // decided per-row in step 3
        await sql.query(
          `UPDATE ${table} SET ${column} = :w WHERE ${column} = :l`,
          { replacements: { w: m.winnerId, l: m.loserId } },
        );
      }
    }

    // 3. Budget actions. Raw SQL on purpose: reconcileCategoryField nulls the
    //    `category` string whenever categoryId changes, and a detached row must
    //    keep its name — that string IS the exact-match the budget rolls up on.
    for (const a of plan.budgetActions) {
      await sql.query('UPDATE budget_targets SET category_id = :c WHERE id = :id', {
        replacements: { c: a.categoryId, id: a.budgetId },
      });
    }

    // 4. Delete the losers, now that nothing references them.
    for (const m of plan.merges) {
      await sql.query('DELETE FROM categories WHERE id = :id', { replacements: { id: m.loserId } });
    }

    // 5. Guard before the unique index, mirroring 20260621000001 step 3.
    const [dupes] = await sql.query(
      'SELECT household_id, name_key, COUNT(*) AS c FROM categories ' +
        'GROUP BY household_id, name_key HAVING COUNT(*) > 1',
    );
    if (dupes.length > 0) {
      throw new Error(
        'category name_key collisions remain after the merge: ' + JSON.stringify(dupes),
      );
    }

    // 6. Swap the indexes. Guarded so a manual re-run is a no-op rather than an
    //    "index already exists" abort; sequelize-cli itself never re-runs a
    //    migration, but this one is the kind someone runs by hand while checking
    //    a merge, and a half-applied index swap is a bad place to land.
    const existing = (await queryInterface.showIndex('categories')).map((i) => i.name);
    if (!existing.includes('categories_household_name_key_unique')) {
      await queryInterface.addIndex('categories', ['household_id', 'name_key'], {
        name: 'categories_household_name_key_unique',
        unique: true,
      });
    }
    for (const stale of [
      'categories_household_parent_name_key_unique',
      'categories_household_root_name_key_unique',
    ]) {
      if (existing.includes(stale)) await queryInterface.removeIndex('categories', stale);
    }
  },

  async down(queryInterface, Sequelize) {
    // Restores the index shape from 20260621000001. The merged rows are NOT
    // restored — that data is gone and there is nothing to recreate it from.
    await queryInterface.addIndex('categories', ['household_id', 'parent_id', 'name_key'], {
      name: 'categories_household_parent_name_key_unique',
      unique: true,
      where: { parent_id: { [Sequelize.Op.ne]: null } },
    });
    await queryInterface.addIndex('categories', ['household_id', 'name_key'], {
      name: 'categories_household_root_name_key_unique',
      unique: true,
      where: { parent_id: null },
    });
    await queryInterface.removeIndex('categories', 'categories_household_name_key_unique');
  },
};
```

Note the step ordering: references are repointed (2) and budgets decided (3) **before** any delete (4), so a `budget_targets` row is never orphaned by a delete that ran first.

- [ ] **Step 4: Update the model's declared indexes**

`backend/src/models/Category.ts:67-80` — replace both partial index declarations with:

```ts
    {
      name: 'categories_household_name_key_unique',
      unique: true,
      fields: ['household_id', 'name_key'],
    },
```

Remove the `Op` import if the typecheck flags it as unused.

- [ ] **Step 5: Run the migration test, then the full suite**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/migrations/__tests__/mergeDuplicateCategoryNamesMigration.test.ts
```
Expected: PASS, 7 tests.

```bash
yarn test
```
Expected: PASS. The unit-test setup builds the schema with `sequelize.sync({ force: true })` from the model, so Step 4 is what makes the new constraint apply across every other test. Any test that created two same-named categories under different parents will now fail — fix the test's fixture, do not weaken the constraint.

- [ ] **Step 6: Commit**

```bash
git add backend/src/migrations/20260930000001-merge-duplicate-category-names.js \
        backend/src/migrations/__tests__/mergeDuplicateCategoryNamesMigration.test.ts \
        backend/src/models/Category.ts
git commit -m "feat(categories): merge duplicate names and make them unique per household"
```

---

### Task 7: Migration — repair the string/id pairs

**Files:**
- Create: `backend/src/migrations/20260930000002-repair-category-string-id-pairs.js`
- Test: `backend/src/migrations/__tests__/repairCategoryStringIdPairsMigration.test.ts`

**Interfaces:**
- Consumes: the post-merge unique names from Task 6 — every name now resolves to exactly one id.
- Produces: nothing downstream.

This must run after `20260930000001`; the filename ordering guarantees it.

- [ ] **Step 1: Write the failing test**

`backend/src/migrations/__tests__/repairCategoryStringIdPairsMigration.test.ts`, same harness as Task 6's — in-memory SQLite, stub tables with only the columns the migration reads.

```ts
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...a: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('categories', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(128), allowNull: false },
    name_key: { type: DataTypes.STRING(128), allowNull: false },
  });
  await qi.createTable('transactions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: true },
    final_category: { type: DataTypes.STRING(128), allowNull: true },
    final_category_id: { type: DataTypes.INTEGER, allowNull: true },
    auto_category: { type: DataTypes.STRING(128), allowNull: true },
    auto_category_id: { type: DataTypes.INTEGER, allowNull: true },
    category_override: { type: DataTypes.STRING(128), allowNull: true },
    category_override_id: { type: DataTypes.INTEGER, allowNull: true },
  });
  await qi.createTable('external_orders', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: true },
  });
  await qi.createTable('external_order_items', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    order_id: { type: DataTypes.INTEGER, allowNull: false },
    inferred_category: { type: DataTypes.STRING(128), allowNull: true },
    inferred_category_id: { type: DataTypes.INTEGER, allowNull: true },
    category_override: { type: DataTypes.STRING(128), allowNull: true },
    category_override_id: { type: DataTypes.INTEGER, allowNull: true },
  });

  await qi.bulkInsert('categories', [
    { id: 1, household_id: 1, name: 'Groceries', name_key: 'groceries' },
    { id: 2, household_id: 1, name: 'Vape', name_key: 'vape' },
    { id: 3, household_id: 1, name: 'Desk', name_key: 'desk' },
    // Same name, different household: must not be borrowed across the boundary.
    { id: 4, household_id: 2, name: 'Groceries', name_key: 'groceries' },
  ]);
  await qi.bulkInsert('transactions', [
    { id: 1, household_id: 1, final_category: 'Groceries', final_category_id: null },
    { id: 2, household_id: 1, final_category: 'Household / Vape', final_category_id: null },
    { id: 3, household_id: 1, final_category: 'Nonsense', final_category_id: null },
    { id: 4, household_id: 1, auto_category: 'groceries', auto_category_id: null },
    { id: 5, household_id: 1, category_override: 'Office / Desk', category_override_id: null },
    { id: 6, household_id: null, final_category: 'Groceries', final_category_id: null },
  ]);
  await qi.bulkInsert('external_orders', [{ id: 1, household_id: 1 }]);
  await qi.bulkInsert('external_order_items', [
    { id: 1, order_id: 1, inferred_category: 'Household / Vape', inferred_category_id: null },
  ]);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260930000002-repair-category-string-id-pairs.js');
  await migration.up(qi, Sequelize);
});

after(async () => { await sequelize.close(); });

async function txn(id: number) {
  const [r] = await sequelize.query(`SELECT * FROM transactions WHERE id = ${id}`);
  return (r as Record<string, unknown>[])[0];
}

test('fills a null id from a flat name without touching the string', async () => {
  const row = await txn(1);
  assert.equal(row.final_category_id, 1);
  assert.equal(row.final_category, 'Groceries', 'the string must be byte-identical');
});

test('rewrites a path-form string to its leaf name and fills the id', async () => {
  const row = await txn(2);
  assert.equal(row.final_category, 'Vape', 'this is what makes the row visible to the Vape budget');
  assert.equal(row.final_category_id, 2);
});

test('leaves a row alone when the name matches no category', async () => {
  const row = await txn(3);
  assert.equal(row.final_category, 'Nonsense');
  assert.equal(row.final_category_id, null);
  const [cats] = await sequelize.query("SELECT id FROM categories WHERE name_key = 'nonsense'");
  assert.deepEqual(cats, [], 'the repair never creates a category');
});

test('normalises a case variant to the stored name', async () => {
  const row = await txn(4);
  assert.equal(row.auto_category, 'Groceries', 'name_key matching is case-insensitive');
  assert.equal(row.auto_category_id, 1);
});

test('repairs category_override and external_order_items too', async () => {
  const row = await txn(5);
  assert.equal(row.category_override, 'Desk');
  assert.equal(row.category_override_id, 3);
  const [items] = await sequelize.query('SELECT * FROM external_order_items WHERE id = 1');
  const item = (items as Record<string, unknown>[])[0];
  assert.equal(item.inferred_category, 'Vape', 'the household comes from the joined order');
  assert.equal(item.inferred_category_id, 2);
});

test('skips a row with no household', async () => {
  const row = await txn(6);
  assert.equal(row.final_category_id, null, 'no household means no unambiguous category');
});

test('is idempotent', async () => {
  const [before_] = await sequelize.query('SELECT * FROM transactions ORDER BY id');
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const [after_] = await sequelize.query('SELECT * FROM transactions ORDER BY id');
  assert.deepEqual(after_, before_);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/migrations/__tests__/repairCategoryStringIdPairsMigration.test.ts
```

Expected: FAIL — the migration file does not exist.

- [ ] **Step 3: Write the migration**

`backend/src/migrations/20260930000002-repair-category-string-id-pairs.js`:

```js
'use strict';

// Repair the (category string, category id) pairs the static-update write paths
// left inconsistent: ~2,800 rows carry a flat name with a NULL id, and ~200
// carry a path-form string ("Household / Rent") that no budget can match,
// because loadCategoryHints feeds the model path-form hints and
// aiBatchOverColdRows persisted them verbatim via Transaction.update, which
// bypasses the beforeSave hook. Those write paths are fixed as of this release;
// this repairs the backlog.
//
// Safe to re-run: it only ever moves a row toward (leaf name, leaf id), and a
// name matching no category is left completely alone.

function normalizeName(name) {
  return String(name).trim().toLocaleLowerCase('en-CA');
}

/** The trailing segment of an "A / B / C" string, or the string itself. */
function leafSegment(value) {
  const parts = String(value).split('/').map((s) => s.trim());
  return parts[parts.length - 1];
}

const TARGETS = [
  ['transactions', 'final_category', 'final_category_id'],
  ['transactions', 'auto_category', 'auto_category_id'],
  ['transactions', 'category_override', 'category_override_id'],
  ['external_order_items', 'inferred_category', 'inferred_category_id'],
  ['external_order_items', 'category_override', 'category_override_id'],
];

module.exports = {
  async up(queryInterface) {
    const sql = queryInterface.sequelize;

    // After 20260930000001 a (household_id, name_key) pair identifies exactly
    // one category, so this map is unambiguous.
    const [categories] = await sql.query('SELECT id, household_id, name, name_key FROM categories');
    const byHouseholdKey = new Map();
    for (const c of categories) {
      byHouseholdKey.set(`${c.household_id} ${c.name_key}`, { id: c.id, name: c.name });
    }

    for (const [table, strCol, idCol] of TARGETS) {
      // external_order_items has no household_id of its own; it reaches one
      // through its order.
      const source = table === 'external_order_items'
        ? `SELECT i.id AS id, o.household_id AS household_id, i.${strCol} AS s, i.${idCol} AS fk
             FROM external_order_items i
             JOIN external_orders o ON o.id = i.order_id
            WHERE i.${strCol} IS NOT NULL`
        : `SELECT id, household_id, ${strCol} AS s, ${idCol} AS fk
             FROM ${table} WHERE ${strCol} IS NOT NULL AND household_id IS NOT NULL`;
      const [rows] = await sql.query(source);

      for (const row of rows) {
        const key = `${row.household_id} ${normalizeName(leafSegment(row.s))}`;
        const node = byHouseholdKey.get(key);
        if (!node) continue;                                  // cannot place it: leave it alone
        if (row.s === node.name && row.fk === node.id) continue; // already correct
        await sql.query(
          `UPDATE ${table} SET ${strCol} = :name, ${idCol} = :id WHERE id = :rowId`,
          { replacements: { name: node.name, id: node.id, rowId: row.id } },
        );
      }
    }
  },

  async down() {
    // Irreversible by design: the pre-repair values were inconsistent and there
    // is nothing to restore them from. The repaired state is the correct one.
  },
};
```

- [ ] **Step 4: Run the migration test**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/migrations/__tests__/repairCategoryStringIdPairsMigration.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/migrations/20260930000002-repair-category-string-id-pairs.js \
        backend/src/migrations/__tests__/repairCategoryStringIdPairsMigration.test.ts
git commit -m "feat(categories): repair the category string and id pairs the static writers left inconsistent"
```

---

### Task 8: Full verification, prod dry run, gated execution

**Files:** none modified.

- [ ] **Step 1: Run everything CI runs**

```bash
yarn ci
```

Expected: PASS — typecheck, all tests, both production builds.

- [ ] **Step 2: Run the code-health audit**

```bash
yarn audit:code
```

Expected: no new clone groups. The planner is shared rather than duplicated precisely so `jscpd` stays quiet — the same reason commit `7219ad43` moved `normalizeMerchant` into `backend/lib/`.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin HEAD
gh pr create --fill
gh pr merge --auto --merge
```

- [ ] **Step 4: Produce the prod dry-run report — READ ONLY**

Use the `cashflow-prod-db` skill. **SELECTs only.** Report, for household 1:

1. The 15 `(loser -> winner)` pairs the planner picks from live reference counts, and confirm they match the 15 pinned in Task 1's first test.
2. Which budgets the planner would detach, and confirm it is exactly 16 and 17.
3. Row counts migration 2 would touch, per table and column.
4. Each budget's `spent` for the current period computed before, and computed after applying the plan and the path repair — the live equivalent of the golden test.

- [ ] **Step 5: STOP. Show Connor the report and the exact statements.**

Do not run a single write against prod until Connor has read the dry-run report and said yes to it. His approval of this plan is **not** approval to write to prod.

- [ ] **Step 6: On approval, migrate prod and read the result back**

```bash
yarn db:migrate
```

Then re-run the Step 4 queries and confirm: zero duplicate `name_key` groups; budgets 16 and 17 have `category_id IS NULL` with their name strings intact; and the only budgets whose `spent` moved are 8, 9 and 14, to the values the golden test pins.

The Dokploy cutover lost at least one write silently — **read every change back**, never assume it landed.

- [ ] **Step 7: Record the outcome**

Capture the executed plan and the observed before/after numbers in kindex, linked to the root-cause and design nodes.
