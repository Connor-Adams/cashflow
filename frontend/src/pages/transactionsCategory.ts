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

/**
 * Returns true when the row's category input has changed from its server-side
 * baseline. Use this to gate whether a PATCH should include categoryOverrideId
 * at all — omitting it when unchanged avoids re-resolving a bare leaf name to
 * a root category and silently overwriting a child-tagged transaction.
 *
 * `baseline` is `t.categoryOverride ?? ''` (the same expression the row's
 * `isDirty` check uses for the category field).
 */
export function categoryFieldChanged(current: string, baseline: string | null): boolean {
  return current !== (baseline ?? '');
}
