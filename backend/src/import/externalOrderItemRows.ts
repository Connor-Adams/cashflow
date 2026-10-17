import type { Transaction } from 'sequelize';
import type { ExtractedReceiptItem } from '../ai/extractReceiptItems';
import type { CategoryMirror } from '../util/ensureCategory';
import { categoryLeafSegment } from '../categories/path';

/** Sequelize DECIMAL columns take strings; an absent amount stays null. */
function decimalOrNull(value: number | null | undefined): string | null {
  return value != null ? String(value) : null;
}

/**
 * Resolve every DISTINCT category name across the items, once each.
 *
 * Deduping matters because this feeds a BULK write: `resolveCategoryMirror`
 * costs two SELECTs for an existing flat name, so resolving per ITEM would turn
 * one `bulkCreate` into 60 category queries for a 30-line receipt across 6
 * categories instead of 12. Keyed by the TRIMMED name, because `ensureCategory`
 * trims before resolving — so `"Coffee"` and `" Coffee "` are one resolution.
 *
 * The caller's transaction is threaded through because `resolveCategoryPath`
 * CREATES missing categories: without it an outer rollback would leave those
 * behind as orphans, and on Postgres these reads would sit outside the
 * uncommitted order's transaction entirely.
 */
async function resolveDistinctCategoryNames(
  householdId: number | null,
  items: ExtractedReceiptItem[],
  transaction: Transaction | undefined,
): Promise<Map<string, CategoryMirror>> {
  const { resolveCategoryMirror } = await import('../util/ensureCategory');
  const names = new Set(
    items.map((it) => it.inferredCategory?.trim()).filter((name): name is string => !!name),
  );
  const resolved = new Map<string, CategoryMirror>();
  for (const name of names) {
    resolved.set(name, await resolveCategoryMirror(householdId, name, { transaction }));
  }
  return resolved;
}

/**
 * The `inferred_category` / `inferred_category_id` pair for one item.
 *
 * The map miss is only reachable for a whitespace-only value (those are filtered
 * out of the resolution set above), which degrades to a null pair.
 */
function categoryFields(
  resolved: Map<string, CategoryMirror>,
  raw: string | null | undefined,
): { inferredCategory: string | null; inferredCategoryId: number | null } {
  const mirror: CategoryMirror =
    raw == null
      ? { name: null, id: null }
      : resolved.get(raw.trim()) ?? { name: categoryLeafSegment(raw), id: null };
  return { inferredCategory: mirror.name, inferredCategoryId: mirror.id };
}

/**
 * Build the `ExternalOrderItem.bulkCreate` rows for a freshly-ingested order,
 * with `inferred_category` / `inferred_category_id` already reconciled.
 *
 * ## Why this exists
 *
 * All three receipt-ingest writers — `persistExtractedOrder`
 * (`routes/externalOrders.ts`, the shared seam behind five routes), `scanInbox`
 * (`integrations/scanReceipts.ts`) and `persistHighConfidenceOrder`
 * (`integrations/discoverReceiptSources.ts`) — write this table with a STATIC
 * `bulkCreate` and no `individualHooks`, so the `beforeSave` hook on the model,
 * the only thing that reconciles the string mirror into the FK, never runs for
 * them. The id therefore has to be supplied explicitly, and the string has to be
 * the resolved leaf's FLAT name: every budget and spend rollup joins
 * `inferred_category` as an exact string, so a path form there matches nothing.
 *
 * Most values reaching these three are flat parser labels (Apple
 * "Subscriptions", Google "Apps", Uber "Transport"), but several seams feed the
 * same column an unconstrained string — `extractReceiptFromText` /
 * `extractReceiptFromImage`, `categorizeUberTrip`, and the user's own
 * purchase-history CSV — so a path form is reachable, and is resolved through
 * the same `resolveCategoryMirror` seam as the four AI writers. All seven behave
 * identically, and a future parser that emits a path is handled for free.
 *
 * ## How this differs from the `beforeSave` hook it stands in for
 *
 * It is NOT the same resolution. The hook calls `resolveCategoryIdByName`, which
 * cannot read a path at all and prefers a ROOT with that name, then a single
 * nested match, else find-or-creates a root. `resolveCategoryMirror` goes
 * through `resolveCategoryPath`, whose lookup is household-GLOBAL and breaks
 * ties to the LOWEST id. The two agree unless a household holds a duplicate name
 * whose nested node is older than the root — then the hook picks the root and
 * this picks the nested node. That divergence is deliberate and transient: the
 * Task 6 household-wide unique index removes the duplicate that causes it.
 */
export async function buildExternalOrderItemRows(args: {
  externalOrderId: number;
  householdId: number | null;
  items: ExtractedReceiptItem[];
  transaction?: Transaction | null;
  /**
   * Whether the extractor's `businessUsePercent` is persisted. Required, not
   * defaulted, because the writers genuinely differ: `scanInbox` and
   * `persistHighConfidenceOrder` have always carried it, while
   * `persistExtractedOrder` has always stored null so an extracted guess never
   * feeds the business/tax split the user did not set.
   */
  carryBusinessUsePercent: boolean;
}): Promise<Record<string, unknown>[]> {
  // A null household is NOT short-circuited here: `resolveCategoryMirror`
  // already returns the leaf-segment-with-null-id pair for that case, and
  // routing every path through it keeps one description of the behaviour.
  const resolved = await resolveDistinctCategoryNames(
    args.householdId,
    args.items,
    args.transaction ?? undefined,
  );

  return args.items.map((it) => ({
    externalOrderId: args.externalOrderId,
    title: it.title,
    quantity: it.quantity,
    unitPrice: decimalOrNull(it.unitPrice),
    totalPrice: decimalOrNull(it.totalPrice),
    ...categoryFields(resolved, it.inferredCategory),
    businessUsePercent: args.carryBusinessUsePercent ? decimalOrNull(it.businessUsePercent) : null,
    confidence: null,
    itemNumber: it.vendorItemId ?? null,
    rawPayload: it as unknown,
  }));
}
