import rateLimit from 'express-rate-limit';

/** 30 uploads per minute per IP; skipped in test so integration tests are stable. */
export const importUploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.UPLOAD_RATE_LIMIT_MAX ?? 30),
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
});
