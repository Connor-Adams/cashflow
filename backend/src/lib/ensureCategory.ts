import { Category } from '../models/Category';

/**
 * Upsert a (householdId, name) row in `categories`. No-op for null / empty /
 * whitespace-only names. Never overwrites an existing `icon` value.
 */
export async function ensureCategory(
  householdId: number,
  name: string | null | undefined
): Promise<void> {
  if (name == null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  await Category.findOrCreate({
    where: { householdId, name: trimmed },
    defaults: { householdId, name: trimmed, icon: null },
  });
}
