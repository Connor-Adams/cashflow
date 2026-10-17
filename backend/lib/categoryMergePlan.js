'use strict';

/**
 * Plan the merge of duplicate (household_id, name_key) category groups.
 * Pure: plain rows in, a plan out. No DB, no Sequelize. Shared by
 * src/migrations/20260930000001-merge-duplicate-category-names.js and by
 * src/categories/mergePlan.budgetInvariance.test.ts so the migration's
 * behaviour is exactly what the golden test proves.
 *
 * WHY THIS IS PLAIN CommonJS AND LIVES OUTSIDE `src/`: `sequelize-cli` loads
 * migrations from `backend/src/migrations/` as plain JS with no TypeScript
 * pipeline, while the app reaches the same function through the typed facade
 * `src/categories/mergePlan.ts`. `src/categories/` and `dist/categories/` sit
 * at the same depth under `backend/`, so `require('../../lib/categoryMergePlan')`
 * resolves identically from the source tree, the build output, and
 * `src/migrations/`. Types for callers live in the sibling
 * `categoryMergePlan.d.ts`. See `lib/merchantNormalization.js` for the same
 * arrangement.
 */

/**
 * Persisted normalization key, same rule as `src/categories/normalizeName.ts`
 * and the category migrations. Duplicated locally rather than imported: this
 * file is plain CommonJS outside `src/` so `sequelize-cli` can load it
 * directly (see the file header), and it must not pull in the TS module.
 */
function normalizeName(name) {
  return String(name).trim().toLocaleLowerCase('en-CA');
}

/**
 * Names of a category and every descendant, over a flat row list.
 * `nameOf` defaults to the raw `name` (the long-standing, still-exported
 * behaviour); pass `normalizeName` to get the same set keyed the way grouping
 * keys duplicates, for the widening comparison below.
 */
function subtreeNames(categories, rootId, nameOf) {
  const pick = nameOf || ((c) => c.name);
  const childrenByParent = new Map();
  const nameById = new Map();
  for (const c of categories) {
    nameById.set(c.id, pick(c));
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

/**
 * True when `after` contains a name `before` lacked — i.e. the counted set
 * WIDENS. Deliberately one-directional: a set that only loses names has
 * NARROWED, which is the deduplication working as intended (a budget on an
 * ancestor of a loser stops seeing the duplicate row's name) and must not
 * detach. Only new names can make a budget count spend it did not count before.
 */
function widens(before, after) {
  for (const v of after) if (!before.has(v)) return true;
  return false;
}

/** Group categories by (householdId, nameKey); only groups of 2+ are duplicates. */
function duplicateGroups(categories) {
  const groups = new Map();
  for (const c of categories) {
    // NUL-joined so a household id or a name_key containing the separator can
    // never collide with a neighbouring group. Same joiner the spend map uses.
    const key = `${c.householdId}\0${c.nameKey}`;
    const list = groups.get(key) || [];
    list.push(c);
    groups.set(key, list);
  }
  return Array.from(groups.values()).filter((members) => members.length >= 2);
}

/** The merges and reparents for one duplicate group. */
function planGroup(members, categories, refOf, merges, reparents) {
  // Rule W: most references wins; ties break to the lowest (oldest) id.
  const winner = members.slice().sort((a, b) => refOf(b.id) - refOf(a.id) || a.id - b.id)[0];
  for (const loser of members) {
    if (loser.id === winner.id) continue;
    merges.push({
      householdId: loser.householdId, nameKey: loser.nameKey,
      winnerId: winner.id, loserId: loser.id,
    });
    // Skip the winner itself: if the winner is its own loser's child (a
    // same-named parent/child pair where the child wins), reparenting it
    // to itself would write parent_id = id -- a self-referential, corrupt
    // row. The winner already has its real (pre-merge) parentId; leave it.
    for (const child of categories) {
      if (child.parentId === loser.id && child.id !== winner.id) {
        reparents.push({ childId: child.id, newParentId: winner.id });
      }
    }
  }
}

/** The post-merge shape, so Rule B compares against what the budget WILL count. */
function postMergeCategories(categories, merges, reparents) {
  const losers = new Set(merges.map((m) => m.loserId));
  const reparentTo = new Map(reparents.map((r) => [r.childId, r.newParentId]));
  return categories
    .filter((c) => !losers.has(c.id))
    .map((c) => (reparentTo.has(c.id) ? Object.assign({}, c, { parentId: reparentTo.get(c.id) }) : c));
}

/**
 * Rule B for one anchored budget, or null when it needs no write.
 *
 * Rule B applies to EVERY anchored budget, not only the ones pointing at a
 * loser: a budget sitting on a WINNER also widens when that winner adopts a
 * loser's children through the `reparents` this planner emits.
 *
 * A merge must never widen what a budget counts. If the post-merge name set
 * gains a name, detach (category_id = NULL, name string retained) -- the
 * exact-match no-rollup form budgets 'Household' and 'Hobbies' already use.
 * Narrowing is fine, and must NOT detach: see `widens` above.
 *
 * Compare NORMALIZED names, the same key grouping used to decide which rows are
 * duplicates. Comparing raw `name` here (Defect: Rule W groups by nameKey, Rule
 * B compared raw names) made a case-only duplicate group (e.g. {'Weed', 'weed'})
 * always look like it widens -- the winner's own raw name never appears in the
 * raw-name "before" set built from the as-is `categories` rows -- so every such
 * merge wrongly detached instead of repointing.
 */
function budgetAction(budget, categories, after, winnerByLoser) {
  const pointsAtLoser = winnerByLoser.has(budget.categoryId);
  const afterId = pointsAtLoser ? winnerByLoser.get(budget.categoryId) : budget.categoryId;
  const normalized = (c) => normalizeName(c.name);
  if (widens(
    subtreeNames(categories, budget.categoryId, normalized),
    subtreeNames(after, afterId, normalized),
  )) {
    return { budgetId: budget.id, action: 'detach', categoryId: null };
  }
  // Only a budget whose anchor row is about to be DELETED needs rewriting.
  return pointsAtLoser ? { budgetId: budget.id, action: 'repoint', categoryId: afterId } : null;
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

  const merges = [];
  const reparents = [];
  for (const members of duplicateGroups(categories)) {
    planGroup(members, categories, refOf, merges, reparents);
  }

  const after = postMergeCategories(categories, merges, reparents);
  const winnerByLoser = new Map(merges.map((m) => [m.loserId, m.winnerId]));
  const budgetActions = budgets
    .filter((b) => b.categoryId != null)
    .map((b) => budgetAction(b, categories, after, winnerByLoser))
    .filter((a) => a !== null);

  return { merges, reparents, budgetActions };
}

module.exports = { planCategoryMerges, subtreeNames };
