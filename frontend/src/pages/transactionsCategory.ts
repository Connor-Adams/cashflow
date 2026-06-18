import { resolveCategoryPath } from '../lib/categoriesApi';

/**
 * Turn a chosen category path string into a transaction PATCH body that tags by id.
 * Empty/whitespace → clears the override (null). Otherwise resolve path → leaf id.
 */
export async function resolveCategoryPatch(pathInput: string): Promise<{ categoryOverrideId: number | null }> {
  const trimmed = pathInput.trim();
  if (!trimmed) return { categoryOverrideId: null };
  const { id } = await resolveCategoryPath(trimmed);
  return { categoryOverrideId: id };
}
