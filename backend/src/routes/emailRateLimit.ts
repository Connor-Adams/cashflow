import rateLimit from 'express-rate-limit';

/**
 * Rate limit for the cost-sensitive email scan/discover triggers (issue #870).
 *
 * Each scan/discover run can fan out into many OpenAI extractions, so triggering
 * them must be throttled independently of the per-day AI-extraction cap (the cap
 * bounds total spend; this bounds how often a run can even start). Modest
 * default: a handful of runs per minute per IP. Skipped under NODE_ENV=test so
 * integration tests stay deterministic, matching the existing
 * importUploadLimiter / aiSuggestLimiter convention.
 */
export const emailScanLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.EMAIL_SCAN_RATE_LIMIT_MAX ?? 5),
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
});
