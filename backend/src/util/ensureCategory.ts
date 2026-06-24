import type { Transaction as SequelizeTransaction } from 'sequelize';
import { resolveCategoryPath } from '../categories/resolvePath';

/**
 * Ensure a category exists for a free-text `name` (e.g. an enrichment
 * `autoCategory`). No-op for null / empty / whitespace-only names.
 *
 * Routes through {@link resolveCategoryPath} so a `"Parent / Child"` value
 * resolves to nested rows (deduped by `nameKey`, reusing existing nodes) rather
 * than being written verbatim as a flat top-level row. A malformed path (empty
 * segment) is swallowed — enrichment is fire-and-forget and a bad mirror name
 * must not fail the batch.
 *
 * Pass `options.transaction` to participate in the caller's transaction —
 * required when called from a Sequelize `afterSave` hook so an outer rollback
 * also rolls back the category insert.
 */
export async function ensureCategory(
  householdId: number,
  name: string | null | undefined,
  options: { transaction?: SequelizeTransaction | null } = {}
): Promise<void> {
  if (name == null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  try {
    await resolveCategoryPath(householdId, trimmed, {
      transaction: options.transaction ?? undefined,
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'invalid category path') return;
    throw err;
  }
}
