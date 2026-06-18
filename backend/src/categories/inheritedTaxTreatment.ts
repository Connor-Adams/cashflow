export type CatTaxNode = {
  id: number;
  parentId: number | null;
  taxTreatment: string;
};

/**
 * Effective tax treatment for a category, inheriting down the hierarchy: the
 * nearest non-'none' taxTreatment found while walking from the category up to
 * its root. A category's own explicit (non-'none') treatment always wins; a
 * 'none' is treated as "unset, inherit". Returns 'none' when neither the
 * category nor any ancestor sets one.
 *
 * Caveat: because taxTreatment defaults to 'none' (and is not nullable), there
 * is no way to express "explicitly not taxable, do NOT inherit" — 'none' always
 * means inherit. Pure over a node map so it is testable without a DB.
 */
export function inheritedTaxTreatment(
  byId: Map<number, CatTaxNode>,
  categoryId: number | null | undefined,
): string {
  let cur: number | null = categoryId ?? null;
  const seen = new Set<number>();
  while (cur != null && byId.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    const node = byId.get(cur)!;
    if (node.taxTreatment && node.taxTreatment !== 'none') return node.taxTreatment;
    cur = node.parentId;
  }
  return 'none';
}
