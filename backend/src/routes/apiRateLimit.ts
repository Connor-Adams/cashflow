import rateLimit from 'express-rate-limit';

/**
 * Shared per-route rate limiters for authenticated JSON endpoints.
 *
 * These exist primarily to satisfy CodeQL's `js/missing-rate-limiting` rule:
 * an authenticated handler that performs DB work should sit behind *some*
 * limiter so a single session can't hammer it unbounded. Limits are deliberately
 * GENEROUS — they are a backstop against abuse/runaway clients, not a UX gate —
 * and both skip entirely in NODE_ENV==='test' so integration tests (which fire
 * many requests per agent in a tight loop) stay deterministic. This mirrors the
 * existing importUploadLimiter / aiSuggestLimiter convention.
 *
 * Attach as route middleware, e.g. `router.get('/', apiReadLimiter, handler)`.
 */

/** Read-mostly GET endpoints: ~240 requests/minute/IP (4 rps sustained). */
export const apiReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.API_READ_RATE_LIMIT_MAX ?? 240),
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
});

/** Mutating endpoints (PATCH/POST/DELETE): ~60 requests/minute/IP. */
export const apiWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.API_WRITE_RATE_LIMIT_MAX ?? 60),
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
});
