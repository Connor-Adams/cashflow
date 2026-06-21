/** Minimal shape needed to decide whether one receipt item is "done". */
export type ItemClearInput = {
  inferredCategory: string | null;
  categoryOverride: string | null;
  /** AI confidence on the 0-100 scale; null when uncategorized. */
  confidence: number | null;
};

/**
 * An item counts as done when the user has overridden its category, or when AI
 * inferred a category at/above the trust threshold. A null/low confidence
 * AI guess is a "straggler" that keeps the parent transaction in review.
 */
export function itemMeetsBar(item: ItemClearInput, threshold: number): boolean {
  if (item.categoryOverride != null && item.categoryOverride !== '') return true;
  return (
    item.inferredCategory != null &&
    item.inferredCategory !== '' &&
    item.confidence != null &&
    item.confidence >= threshold
  );
}

/**
 * A transaction clears review from its items only when it HAS items and EVERY
 * item meets the bar. Zero items => false, so callers fall back to the normal
 * (signal-based) review logic.
 */
export function transactionClearsFromItems(items: ItemClearInput[], threshold: number): boolean {
  if (items.length === 0) return false;
  return items.every((i) => itemMeetsBar(i, threshold));
}
