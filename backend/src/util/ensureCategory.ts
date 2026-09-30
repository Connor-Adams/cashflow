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
