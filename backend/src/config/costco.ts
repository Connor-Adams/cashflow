/** Optional hosted-scraper integration for Costco product enrichment.
 *  No key (or disabled flag) => the resolver no-ops. */
export function getCostcoScraperConfig(): { apiKey: string; baseUrl: string } | null {
  const apiKey = process.env.COSTCO_SCRAPER_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = process.env.COSTCO_SCRAPER_BASE_URL?.trim() || 'https://data.unwrangle.com/api/getter/';
  return { apiKey, baseUrl };
}

/** Which Costco enrichment source to use. */
export function getCostcoProvider(): 'unwrangle' | 'google' {
  const p = process.env.COSTCO_SCRAPER_PROVIDER?.trim().toLowerCase();
  return p === 'google' ? 'google' : 'unwrangle';
}

/** Google Custom Search (free image source). Null if unconfigured. */
export function getGoogleCseConfig(): { apiKey: string; cx: string } | null {
  const apiKey = process.env.GOOGLE_CSE_API_KEY?.trim();
  const cx = process.env.GOOGLE_CSE_CX?.trim();
  if (!apiKey || !cx) return null;
  return { apiKey, cx };
}
