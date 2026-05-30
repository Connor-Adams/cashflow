import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

/**
 * Feedback submissions are user-scoped and flood-prone (issue #295 AC#5:
 * the 6th submission within 60s must return 429 RATE_LIMITED).
 *
 * Unlike every other limiter in this app (aiRateLimit, importRateLimit,
 * clientLogs, chatRateLimit) we deliberately do NOT `skip` in test, so the
 * rate-limit AC can be verified end-to-end. Keying by the authenticated user
 * id — always present, the route is behind requireAuth — means only a single
 * user's feedback POSTs share a window, so other integration tests (which
 * seed their own users and never POST /api/feedback) are unaffected.
 */
export const feedbackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.FEEDBACK_RATE_LIMIT_MAX ?? 5),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `feedback:${req.auth?.user.id ?? 'anon'}`,
  // The custom key never derives from the client IP, so disable express-rate-
  // limit v8's IPv6 key-fallback validation (it would warn about a non-IP key).
  validate: { keyGeneratorIpFallback: false },
  handler: (_req, res) => {
    res.status(429).json({ error: 'RATE_LIMITED' });
  },
});
