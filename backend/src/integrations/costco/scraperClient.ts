import { getCostcoScraperConfig } from '../../config/costco';

/** A search result candidate — just enough to fetch the product page. */
export type CostcoSearchHit = {
  url: string;
  title: string;
};

/** Normalized product data from a Costco product page. */
export type CostcoProductData = {
  /** Costco item number as listed on the product page; null if absent. */
  itemNumber: string | null;
  title: string;
  imageUrl: string | null;
  url: string;
  price: number | null;
};

/** Scraper-agnostic caller the resolver depends on. Swap the impl to change vendor. */
export type CostcoScraperCaller = {
  /** Search Costco by keyword; returns candidate product pages (best-first). */
  search(keyword: string): Promise<CostcoSearchHit[]>;
  /** Fetch normalized product data for one product page URL. */
  fetchProduct(url: string): Promise<CostcoProductData | null>;
  /** Identifier stored on the cache row's `source` column. */
  readonly source: string;
};

/**
 * Unwrangle adapter. NOTE: the exact response field names below are per
 * Unwrangle's documented shape and MUST be verified against a live response
 * during first integration — adjust the `as` casts + field reads if they differ.
 * All tested resolver logic depends on the NORMALIZED types above, not this.
 */
export function createUnwrangleCaller(
  cfg: { apiKey: string; baseUrl: string },
  fetchImpl: typeof fetch = fetch,
): CostcoScraperCaller {
  async function getJson(params: Record<string, string>): Promise<Record<string, unknown>> {
    const url = new URL(cfg.baseUrl);
    url.searchParams.set('api_key', cfg.apiKey);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetchImpl(url.toString());
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Costco scraper error ${res.status}: ${t.slice(0, 300)}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  return {
    source: 'unwrangle',
    async search(keyword) {
      const data = await getJson({ platform: 'costco_search', search: keyword });
      const results = Array.isArray(data.results) ? data.results : [];
      return results
        .map((r): CostcoSearchHit | null => {
          if (!r || typeof r !== 'object') return null;
          const o = r as Record<string, unknown>;
          const url = typeof o.url === 'string' ? o.url : null;
          const title = typeof o.name === 'string' ? o.name : '';
          return url ? { url, title } : null;
        })
        .filter((h): h is CostcoSearchHit => h != null);
    },
    async fetchProduct(productUrl) {
      const data = await getJson({ platform: 'costco_detail', url: productUrl });
      const d = (data.detail ?? data) as Record<string, unknown>;
      const itemNumber =
        d.item_number != null ? String(d.item_number) : null;
      const title = typeof d.name === 'string' ? d.name : '';
      const imageUrl = typeof d.main_image === 'string' ? d.main_image : null;
      const priceRaw = d.price;
      const price =
        typeof priceRaw === 'number'
          ? priceRaw
          : typeof priceRaw === 'string' && priceRaw.trim() !== ''
            ? Number(priceRaw)
            : null;
      return {
        itemNumber,
        title,
        imageUrl,
        url: productUrl,
        price: price != null && Number.isFinite(price) ? price : null,
      };
    },
  };
}

/** Default caller from env, or null if unconfigured. */
export function defaultCostcoScraperCaller(): CostcoScraperCaller | null {
  const cfg = getCostcoScraperConfig();
  if (!cfg) return null;
  return createUnwrangleCaller(cfg);
}
