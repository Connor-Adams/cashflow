import type { Transaction } from 'sequelize';
import type { ExtractedReceiptItem } from '../ai/extractReceiptItems';
import type { EnsuredCategory } from '../util/ensureCategory';
import { categoryLeafSegment } from '../categories/path';

/** Sequelize DECIMAL columns take strings; an absent amount stays null. */
function decimalOrNull(value: number | null | undefined): string | null {
  return value != null ? String(value) : null;
}

/**
 * Resolve every DISTINCT category name across the items, once each.
 *
 * Deduping matters because this feeds a BULK write: `ensureCategory` costs two
 * SELECTs for an existing flat name, so resolving per ITEM would turn one
 * `bulkCreate` into 60 category queries for a 30-line receipt across 6
 * categories instead of 12. Keyed by the TRIMMED name, because `ensureCategory`
 * trims before resolving — so `"Coffee"` and `" Coffee "` are one resolution.
 *
 * The caller's transaction is threaded through because `resolveCategoryPath`
 * CREATES missing categories: without it an outer rollback would leave those
 * behind as orphans, and on Postgres these reads would sit outside the
 * uncommitted order's transaction entirely.
 */
async function resolveDistinctCategoryNames(
  householdId: number,
  items: ExtractedReceiptItem[],
  transaction: Transaction | undefined,
): Promise<Map<string, EnsuredCategory | null>> {
  const { ensureCategory } = await import('../util/ensureCategory');
  const names = new Set(
    items.map((it) => it.inferredCategory?.trim()).filter((name): name is string => !!name),
  );
  const resolved = new Map<string, EnsuredCategory | null>();
  for (const name of names) {
    resolved.set(name, await ensureCategory(householdId, name, { transaction }));
  }
  return resolved;
}

/** The resolved leaf for one item's raw category value, or null. */
function leafFor(
  resolved: Map<string, EnsuredCategory | null>,
  raw: string | null | undefined,
): EnsuredCategory | null {
  if (raw == null) return null;
  return resolved.get(raw.trim()) ?? null;
}

/** The `inferred_category` / `inferred_category_id` pair for one item. */
function categoryFields(
  leaf: EnsuredCategory | null,
  raw: string | null | undefined,
): { inferredCategory: string | null; inferredCategoryId: number | null } {
  if (leaf) return { inferredCategory: leaf.name, inferredCategoryId: leaf.id };
  // Nothing resolved (no household, empty name, malformed path): fall back to
  // the LEAF SEGMENT, never the raw string — writing the raw string back is the
  // bug, since the raw string may itself be the path form.
  return { inferredCategory: categoryLeafSegment(raw), inferredCategoryId: null };
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
 * the same `ensureCategory` seam as the four AI writers. All seven behave
 * identically, and a future parser that emits a path is handled for free.
 */
export async function buildExternalOrderItemRows(args: {
  externalOrderId: number;
  householdId: number | null;
  items: ExtractedReceiptItem[];
  transaction?: Transaction | null;
}): Promise<Record<string, unknown>[]> {
  const resolved =
    args.householdId == null
      ? new Map<string, EnsuredCategory | null>()
      : await resolveDistinctCategoryNames(
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
    ...categoryFields(leafFor(resolved, it.inferredCategory), it.inferredCategory),
    businessUsePercent: decimalOrNull(it.businessUsePercent),
    confidence: null,
    itemNumber: it.vendorItemId ?? null,
    rawPayload: it as unknown,
  }));
}
