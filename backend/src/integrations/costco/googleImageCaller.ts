import type { PerItemResolver, ResolvedProduct } from '../../import/enrichment/resolveCostcoProducts';
import { itemNumbersMatch } from '../../import/enrichment/resolveCostcoProducts';
import { itemNumberFromText } from './itemNumberFromText';
import { logger } from '../../observability/logger';

const SOURCE = 'google_cse';
const ENDPOINT = 'https://www.googleapis.com/customsearch/v1';

type GoogleItem = { link?: string; title?: string; snippet?: string; image?: { contextLink?: string } };

/**
 * Best-effort per-item resolver backed by Google Custom Search (image mode,
 * site-restricted to costco.com via the CX config). verified=true only when an
 * item number recovered from a result's text matches the receipt's; otherwise
 * the top result is stored as a guess (verified=false). Never throws.
 */
export function makeGoogleBestEffortResolver(
  cfg: { apiKey: string; cx: string },
  fetchImpl: typeof fetch = fetch,
): PerItemResolver {
  return async (itemNumber, name): Promise<ResolvedProduct> => {
    try {
      const url = new URL(ENDPOINT);
      url.searchParams.set('key', cfg.apiKey);
      url.searchParams.set('cx', cfg.cx);
      url.searchParams.set('searchType', 'image');
      url.searchParams.set('num', '5');
      url.searchParams.set('q', `${name} item ${itemNumber} site:costco.com`);
      const res = await fetchImpl(url.toString());
      if (!res.ok) throw new Error(`Google CSE ${res.status}`);
      const data = (await res.json()) as { items?: GoogleItem[] };
      const items = Array.isArray(data.items) ? data.items : [];
      const candidates = items.filter((it) => typeof it.link === 'string');
      if (candidates.length === 0) {
        return { itemNumber, status: 'not_found', imageUrl: null, costcoUrl: null, officialName: null, onlinePrice: null, source: SOURCE, verified: true };
      }
      const verified = candidates.find((it) => {
        const found = itemNumberFromText(`${it.title ?? ''} ${it.snippet ?? ''} ${it.image?.contextLink ?? ''}`);
        return itemNumbersMatch(itemNumber, found);
      });
      const chosen = verified ?? candidates[0];
      return {
        itemNumber,
        status: 'resolved',
        imageUrl: chosen.link as string,
        costcoUrl: chosen.image?.contextLink ?? null,
        officialName: chosen.title ?? null,
        onlinePrice: null,
        source: SOURCE,
        verified: Boolean(verified),
      };
    } catch (err) {
      logger.warn({ err, itemNumber, module: 'googleImageCaller' }, 'costco_google_resolve_failed');
      return { itemNumber, status: 'error', imageUrl: null, costcoUrl: null, officialName: null, onlinePrice: null, source: SOURCE, verified: true };
    }
  };
}
