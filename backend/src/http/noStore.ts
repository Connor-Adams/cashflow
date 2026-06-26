import type { Request, Response, NextFunction } from 'express';

/**
 * Global `Cache-Control: no-store` for the `/api` surface (issue #853).
 *
 * Every `/api` response carries financial PII or account-scoped data — CSV/NDJSON
 * exports, receipt/vault file downloads, transaction lists, tax summaries. Without
 * an explicit cache directive (or with the weaker `no-cache`, which only forces
 * revalidation and still permits on-disk storage) browsers and intermediary
 * proxies may persist these responses to disk, where a later user of a shared
 * machine can read them straight out of the cache.
 *
 * `no-store` is the correct directive: it forbids any caching of the request or
 * response in any cache. We set it globally rather than per-route so a new
 * endpoint can never silently regress by forgetting the header.
 *
 * Streaming handlers (SSE / NDJSON) intentionally `res.setHeader('Cache-Control', …)`
 * themselves with `no-store, no-transform` — `no-transform` additionally stops a
 * proxy from buffering/altering the stream. Because they set the header in the
 * handler (after this middleware runs) their value wins for those routes, which is
 * correct: they keep `no-store` plus the extra streaming directive.
 */
export function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  next();
}
