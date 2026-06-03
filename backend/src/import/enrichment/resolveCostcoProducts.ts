/**
 * resolveCostcoProducts — enrich Costco receipt items with a VERIFIED product
 * image + URL. Searches a hosted scraper by the item's readable name, fetches
 * candidate product pages, and accepts a product ONLY when its item number
 * matches the receipt's item_number. Results are cached in costco_products,
 * keyed by the global item_number, so one resolution serves every household.
 *
 * Structure mirrors expandItemNames.ts: an injectable caller, PURE helpers,
 * a DB loader, an apply writer, and a best-effort `maybeResolve…ForOrder` gate
 * that no-ops when disabled/unconfigured and never throws to the caller.
 *
 * Runs OUTSIDE ingest: scrape latency / rate limits never block receipt upload.
 */
import type { CostcoProductData } from '../../integrations/costco/scraperClient';

/** Vendors eligible for product-image resolution (ExternalOrder.vendor). */
export const RESOLVE_VENDORS = ['costco'] as const;

/** Max search candidates whose product page we fetch+verify per item. */
const MAX_CANDIDATES = 2;

/** Digits-only equality; tolerates leading zeros and surrounding text. Null/empty never match. */
export function itemNumbersMatch(a: string | null, b: string | null): boolean {
  if (a == null || b == null) return false;
  const da = a.replace(/\D/g, '').replace(/^0+/, '');
  const db = b.replace(/\D/g, '').replace(/^0+/, '');
  if (da === '' || db === '') return false;
  return da === db;
}

/** First candidate whose item number matches the receipt item number, else null. PURE. */
export function pickVerifiedProduct(
  receiptItemNumber: string,
  candidates: CostcoProductData[],
): CostcoProductData | null {
  for (const c of candidates) {
    if (itemNumbersMatch(receiptItemNumber, c.itemNumber)) return c;
  }
  return null;
}
