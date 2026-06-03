/** Optional hosted-scraper integration for Costco product enrichment.
 *  No key (or disabled flag) => the resolver no-ops. */
export function getCostcoScraperConfig(): { apiKey: string; baseUrl: string } | null {
  const apiKey = process.env.COSTCO_SCRAPER_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = process.env.COSTCO_SCRAPER_BASE_URL?.trim() || 'https://data.unwrangle.com/api/getter/';
  return { apiKey, baseUrl };
}
