import type { Transaction as SequelizeTransaction } from 'sequelize';
import { Category } from '../models/Category';
import { resolveCategoryPath } from '../categories/resolvePath';
import { categoryLeafSegment } from '../categories/path';

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
    // resolveCategoryPath just returned this id inside the same transaction, so
    // a miss is an invariant violation. Returning null here would make callers
    // write the name with a NULL id, the exact row this function exists to stop.
    if (!leaf) throw new Error(`ensureCategory: resolved leaf ${leafId} not found`);
    return { id: leaf.id, name: leaf.name };
  } catch (err) {
    if (err instanceof Error && err.message === 'invalid category path') return null;
    throw err;
  }
}

/**
 * The `<x>_category` / `<x>_category_id` pair a STATIC writer has to supply for
 * itself. `name` is always the resolved node's FLAT name (or, when nothing
 * resolved, the raw value's last path segment) — never a path, because every
 * budget and spend rollup joins these string columns as an exact value.
 */
export interface CategoryMirror {
  name: string | null;
  id: number | null;
}

/**
 * Resolve a free-text category value into the mirror pair above, in TWO steps.
 *
 * Step 1 is {@link ensureCategory} on the raw value, which handles a flat name
 * and a well-formed `"Parent / Child"` path alike. Step 2 exists because step 1
 * returns null for a MALFORMED path — `"Household // Rent"`, `"Rent/"`,
 * `"/Rent"` all make `parseCategoryPath` throw on the empty segment. Writing
 * just the leaf segment in that case would persist `category='Rent'` with a NULL
 * FK: precisely the flat-name-plus-NULL-FK row these writers exist to stop
 * producing, and one the repair migration would then have to clean up again. So
 * when a household is present the leaf segment is re-resolved on its own — it is
 * a flat name by construction and cannot contain an empty segment — and its id
 * is used.
 *
 * The FK is therefore null ONLY when there is no household to resolve against,
 * or no non-empty segment to resolve at all.
 *
 * This is the one place that two-step fallback lives: all seven static category
 * writers call it, so they cannot drift apart. Note this resolves through
 * `resolveCategoryPath` (household-GLOBAL lookup, lowest id wins) rather than
 * the `beforeSave` hooks' `resolveCategoryIdByName` (root-preferring, then a
 * single nested match, else find-or-create a root) — see the writers' comments.
 */
export async function resolveCategoryMirror(
  householdId: number | null | undefined,
  raw: string | null | undefined,
  options: { transaction?: SequelizeTransaction | null } = {}
): Promise<CategoryMirror> {
  const leafSegment = categoryLeafSegment(raw);
  // Nothing to resolve against, or nothing resolvable: the leaf segment is all
  // that can be salvaged, and writing the RAW string back is the original bug.
  if (householdId == null || leafSegment == null) return { name: leafSegment, id: null };

  const direct = await ensureCategory(householdId, raw, options);
  if (direct) return { name: direct.name, id: direct.id };
  // The raw value already WAS its own leaf (a flat name), so re-resolving it
  // would just repeat the query that returned null.
  if (leafSegment === raw!.trim()) return { name: leafSegment, id: null };

  const viaLeaf = await ensureCategory(householdId, leafSegment, options);
  return { name: viaLeaf?.name ?? leafSegment, id: viaLeaf?.id ?? null };
}
