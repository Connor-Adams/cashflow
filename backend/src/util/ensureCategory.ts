import { Category } from '../models/Category';
import type { Transaction as SequelizeTransaction } from 'sequelize';

/**
 * Upsert a (householdId, name) row in `categories`. No-op for null / empty /
 * whitespace-only names. Never overwrites an existing `icon` value.
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
  await Category.findOrCreate({
    where: { householdId, name: trimmed },
    defaults: { householdId, name: trimmed, icon: null },
    transaction: options.transaction ?? undefined,
  });
}
