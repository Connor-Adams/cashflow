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
import { defaultCostcoScraperCaller } from '../../integrations/costco/scraperClient';
import type { CostcoProductStatus } from '../../models/CostcoProduct';
import { ExternalOrder, ExternalOrderItem, CostcoProduct } from '../../models';
import { costcoEnrichmentEnabled, costcoEnrichmentMaxItemsPerRun } from '../../config/env';
import { getCostcoScraperConfig, getCostcoProvider, getGoogleCseConfig } from '../../config/costco';
import { makeGoogleBestEffortResolver } from '../../integrations/costco/googleImageCaller';
import { Op } from 'sequelize';
import { logger } from '../../observability/logger';

/** Vendors eligible for product-image resolution (ExternalOrder.vendor). */
export const RESOLVE_VENDORS = ['costco'] as const;

/** Max search candidates whose product page we fetch+verify per item. */
const MAX_CANDIDATES = 2;

/** Error rows are retried on subsequent runs but capped here (see migration comment). */
const MAX_ERROR_ATTEMPTS = 5;

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
  verified: boolean;
};

function notFound(itemNumber: string, source: string): ResolvedProduct {
  return { itemNumber, status: 'not_found', imageUrl: null, costcoUrl: null, officialName: null, onlinePrice: null, source, verified: true };
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
      verified: true,
    };
  } catch (err) {
    logger.warn({ err, itemNumber, module: 'resolveCostcoProducts' }, 'costco_resolve_one_failed');
    return { itemNumber, status: 'error', imageUrl: null, costcoUrl: null, officialName: null, onlinePrice: null, source: caller.source, verified: true };
  }
}

export type ItemNumberToResolve = { itemNumber: string; name: string };

export type PerItemResolver = (itemNumber: string, name: string) => Promise<ResolvedProduct>;

/** Build a per-item resolver for the strict (item-number-verified) scraper path. */
export function strictResolver(caller: CostcoScraperCaller): PerItemResolver {
  return (itemNumber, name) => resolveOneItemNumber(itemNumber, name, caller);
}

/** Pick the configured provider's per-item resolver, or null if unconfigured. */
export function selectResolver(opts?: { caller?: CostcoScraperCaller }): PerItemResolver | null {
  if (getCostcoProvider() === 'google') {
    const cfg = getGoogleCseConfig();
    return cfg ? makeGoogleBestEffortResolver(cfg) : null;
  }
  const caller = opts?.caller ?? defaultCostcoScraperCaller();
  if (!caller || getCostcoScraperConfig() == null) return null;
  return strictResolver(caller);
}

/** Statuses that mean "don't query again" (error rows may be retried elsewhere). */
const TERMINAL_CACHED = new Set<CostcoProductStatus>(['resolved', 'not_found']);

async function upsertResolved(r: ResolvedProduct): Promise<void> {
  const [row, created] = await CostcoProduct.findOrCreate({
    where: { itemNumber: r.itemNumber },
    defaults: {
      itemNumber: r.itemNumber,
      status: r.status,
      imageUrl: r.imageUrl,
      costcoUrl: r.costcoUrl,
      officialName: r.officialName,
      onlinePrice: r.onlinePrice,
      source: r.source,
      verified: r.verified,
      attempts: 1,
      fetchedAt: new Date(),
    },
  });
  if (!created) {
    await row.update({
      status: r.status,
      imageUrl: r.imageUrl,
      costcoUrl: r.costcoUrl,
      officialName: r.officialName,
      onlinePrice: r.onlinePrice,
      source: r.source,
      verified: r.verified,
      attempts: row.attempts + 1,
      fetchedAt: new Date(),
    });
  }
}

/**
 * Resolve a set of (itemNumber, name) pairs: skip any already cached as
 * resolved/not_found, attempt up to `maxItems` of the rest, and upsert results.
 * Sequential — no concurrent scraper calls. Returns count newly resolved.
 */
export async function resolveCostcoProductsForItemNumbers(
  items: ItemNumberToResolve[],
  resolveItem: PerItemResolver,
  opts?: { maxItems?: number },
): Promise<number> {
  const byNumber = new Map<string, string>();
  for (const it of items) {
    const num = it.itemNumber?.trim();
    if (num) byNumber.set(num, it.name);
  }
  const numbers = [...byNumber.keys()];

  const existing = await CostcoProduct.findAll({ where: { itemNumber: { [Op.in]: numbers } } });
  const skip = new Set(
    existing
      .filter((p) =>
        TERMINAL_CACHED.has(p.status) ||
        (p.status === 'error' && p.attempts >= MAX_ERROR_ATTEMPTS),
      )
      .map((p) => p.itemNumber),
  );

  const cap = opts?.maxItems ?? costcoEnrichmentMaxItemsPerRun;
  let attempted = 0;
  let resolved = 0;
  for (const num of numbers) {
    if (skip.has(num)) continue;
    if (attempted >= cap) break;
    attempted += 1;
    const result = await resolveItem(num, byNumber.get(num) ?? num);
    await upsertResolved(result);
    if (result.status === 'resolved') resolved += 1;
  }
  return resolved;
}

/**
 * Best-effort gate for one order's Costco items. No-ops when disabled /
 * unconfigured. NEVER throws — a flaky scraper can't fail receipt ingest.
 */
export async function maybeResolveCostcoProductsForOrder(
  args: { householdId: number; orderId: number },
  opts?: { caller?: CostcoScraperCaller; resolver?: PerItemResolver },
): Promise<number> {
  if (!costcoEnrichmentEnabled) return 0;
  const resolveItem = opts?.resolver ?? selectResolver({ caller: opts?.caller });
  if (resolveItem == null) return 0;
  try {
    const items = await ExternalOrderItem.findAll({
      where: { itemNumber: { [Op.ne]: null } },
      include: [{
        model: ExternalOrder, as: 'order', required: true,
        where: { id: args.orderId, householdId: args.householdId, vendor: { [Op.in]: RESOLVE_VENDORS as unknown as string[] } },
      }],
    });
    const toResolve: ItemNumberToResolve[] = items
      .filter((it) => it.itemNumber != null)
      .map((it) => ({ itemNumber: it.itemNumber as string, name: it.displayName ?? it.title }));
    return await resolveCostcoProductsForItemNumbers(toResolve, resolveItem);
  } catch (err) {
    logger.warn({ err, orderId: args.orderId, module: 'resolveCostcoProducts' }, 'costco_resolve_order_failed');
    return 0;
  }
}
