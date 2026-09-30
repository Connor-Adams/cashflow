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
    // NUL-joined so a household id or a name_key containing the separator can
    // never collide with a neighbouring group. Same joiner the spend map uses.
    const key = `${c.householdId}\0${c.nameKey}`;
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
