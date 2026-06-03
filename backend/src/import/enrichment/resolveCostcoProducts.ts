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
import type { CostcoProductData, CostcoScraperCaller } from '../../integrations/costco/scraperClient';
import type { CostcoProductStatus } from '../../models/CostcoProduct';
import { logger } from '../../observability/logger';

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

/** The cache-row fields produced by resolving one item number. */
export type ResolvedProduct = {
  itemNumber: string;
  status: CostcoProductStatus;
  imageUrl: string | null;
  costcoUrl: string | null;
  officialName: string | null;
  onlinePrice: string | null;
  source: string;
};

function notFound(itemNumber: string, source: string): ResolvedProduct {
  return { itemNumber, status: 'not_found', imageUrl: null, costcoUrl: null, officialName: null, onlinePrice: null, source };
}

/**
 * Resolve ONE item number against the scraper: search by name, fetch up to
 * MAX_CANDIDATES product pages, accept the first whose item number matches.
 * Never throws — transport/parse failures map to status 'error'.
 */
export async function resolveOneItemNumber(
  itemNumber: string,
  name: string,
  caller: CostcoScraperCaller,
): Promise<ResolvedProduct> {
  try {
    const hits = await caller.search(name);
    const candidates: CostcoProductData[] = [];
    for (const hit of hits.slice(0, MAX_CANDIDATES)) {
      const prod = await caller.fetchProduct(hit.url);
      if (prod) candidates.push(prod);
    }
    const match = pickVerifiedProduct(itemNumber, candidates);
    if (!match) return notFound(itemNumber, caller.source);
    return {
      itemNumber,
      status: 'resolved',
      imageUrl: match.imageUrl,
      costcoUrl: match.url,
      officialName: match.title || null,
      onlinePrice: match.price != null ? String(match.price) : null,
      source: caller.source,
    };
  } catch (err) {
    logger.warn({ err, itemNumber, module: 'resolveCostcoProducts' }, 'costco_resolve_one_failed');
    return { itemNumber, status: 'error', imageUrl: null, costcoUrl: null, officialName: null, onlinePrice: null, source: caller.source };
  }
}
