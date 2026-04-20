import rateLimit from 'express-rate-limit';

/** AI calls are cost-sensitive; keep modest defaults. */
export const aiSuggestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.AI_RATE_LIMIT_MAX ?? 20),
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
});
