// backend/src/categories/resolvePath.ts
import { UniqueConstraintError, type Transaction } from 'sequelize';
import { Category } from '../models';
import { sequelize } from '../db';
import { parseCategoryPath } from './path';
import { normalizeCategoryName } from './normalizeName';

export interface ResolvedPath {
  leafId: number;
  createdIds: number[];
}

/**
 * Find an existing node for this name ANYWHERE in the household.
 *
 * This lookup is deliberately household-GLOBAL rather than parent-scoped, so a
 * flat name cannot fork an existing category into a duplicate root: a path is a
 * hint about where a NEW category belongs, not an address — if the name already
 * exists the walk reuses that node whatever its parent, and never reparents it.
 * Resolving parent-scoped is what let the nightly enrichment job fork 15
 * categories into duplicate roots on 2026-09-29.
 *
 * The household-wide uniqueness guarantee this leans on does NOT exist yet: the
 * live schema still carries only the two PARTIAL indexes
 * (`categories_household_parent_name_key_unique` and
 * `categories_household_root_name_key_unique`), and `createCategory.ts` enforces
 * uniqueness only among siblings — so a user can still mint a root `Groceries`
 * beside a nested `Groceries` today. The household-wide unique index arrives
 * with the Task 6 merge migration; until it lands, duplicates exist and this
 * lookup must be deterministic about which one it picks.
 *
 * Hence `ORDER BY id ASC`: the OLDEST node wins. Postgres guarantees no heap
 * order, so an unordered `LIMIT 1` returns whichever half of a duplicate pair
 * the planner happens to hand back — and that shifts after updates and VACUUM,
 * so two nightly enrichment runs could resolve the same name to different
 * nodes. Lowest-id also matches the merge planner's tie-break in
 * `backend/lib/categoryMergePlan.js` ("most references wins; ties break to the
 * lowest (oldest) id"), so the resolver and the planner agree on which node is
 * canonical.
 *
 * See docs/superpowers/specs/2026-09-30-cashflow-duplicate-categories-design.md.
 */
async function findByName(
  householdId: number,
  nameKey: string,
  transaction: Transaction,
): Promise<Category | null> {
  return Category.findOne({
    where: { householdId, nameKey },
    order: [['id', 'ASC']],
    transaction,
  });
}

/**
 * Reduce a path to its longest prefix containing no repeated `name_key`.
 *
 * Under the household-global lookup above a name denotes exactly ONE node per
 * household, so a segment that repeats an earlier name adds no information: it
 * can only resolve back to the node the walk has already visited. Walking past
 * it is incoherent either way — it returns a `leafId` that is an ANCESTOR of a
 * node the same call just created (leaving that node dangling and unreachable),
 * or it contradicts the earlier segment. Truncating keeps the answer
 * well-defined and creates nothing after the repetition, so the orphan is
 * impossible by construction.
 *
 * Truncating rather than REJECTING matters because the UI hands users these
 * paths: `flattenTreeToPaths` in `frontend/src/lib/categoriesApi.ts` emits every
 * node's full root-to-node path, and `createCategory.ts` enforces only SIBLING
 * uniqueness — so a child `Food` under a root `Food` is legal on today's schema
 * and flattens to `"Food / Food"`. A 400 there would reject a value the server's
 * own tree offered.
 *
 * `"Food / Food"` walks `['Food']` → the `Food` node, creating nothing.
 * `"Food / Bar / Food"` walks `['Food', 'Bar']` → `Bar` under `Food`.
 */
function truncateAtRepeatedName(segments: string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const segment of segments) {
    const nameKey = normalizeCategoryName(segment);
    if (seen.has(nameKey)) break;
    seen.add(nameKey);
    kept.push(segment);
  }
  return kept;
}

export async function resolveCategoryPath(
  householdId: number,
  input: string,
  opts: { transaction?: Transaction } = {},
): Promise<ResolvedPath> {
  const segments = truncateAtRepeatedName(parseCategoryPath(input));

  const run = async (transaction: Transaction): Promise<ResolvedPath> => {
    let parentId: number | null = null;
    const createdIds: number[] = [];
    let leafId = 0;
    for (const segment of segments) {
      const nameKey = normalizeCategoryName(segment);
      let node = await findByName(householdId, nameKey, transaction);
      if (!node) {
        try {
          // The INSERT runs in a NESTED transaction so Sequelize wraps it in a
          // SAVEPOINT. Without one, a concurrent writer that wins the race makes
          // this INSERT raise a unique violation that puts the WHOLE Postgres
          // transaction into aborted state (SQLSTATE 25P02) — the re-lookup below
          // would then itself fail with "current transaction is aborted" and the
          // caller never sees the concurrent winner. The retry only ever worked
          // on SQLite, and production is Postgres. With the savepoint, Sequelize
          // issues ROLLBACK TO SAVEPOINT on the failure, the outer transaction
          // survives, and the re-lookup can find the row the winner committed.
          // That re-lookup depends on READ COMMITTED — Postgres's default, and
          // nothing in backend/src sets `isolationLevel`. Under REPEATABLE READ
          // the outer snapshot predates the winner's commit, so the re-lookup
          // returns null and the original violation is rethrown: a safe failure,
          // not a wrong answer, but a silent surprise if the isolation level is
          // ever raised.
          node = await sequelize.transaction({ transaction }, (inner) =>
            Category.create(
              { householdId, parentId, name: segment, icon: null },
              { transaction: inner },
            ),
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
    return { leafId, createdIds };
  };

  if (opts.transaction) return run(opts.transaction);
  return sequelize.transaction((t) => run(t));
}
