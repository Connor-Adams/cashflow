import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { ClientLogLevel, ClientLogPayload } from '@cashflow/shared';
import { logger } from '../observability/logger';

const router = Router();

const clientLogLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.CLIENT_LOG_RATE_LIMIT_MAX ?? 120),
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
});

function asLevel(value: unknown): ClientLogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
    ? value
    : 'info';
}

function cleanString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function cleanFields(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (Object.keys(out).length >= 20) break;
    if (!/^[a-zA-Z0-9_.-]{1,60}$/.test(key)) continue;
    if (
      raw == null ||
      typeof raw === 'string' ||
      typeof raw === 'number' ||
      typeof raw === 'boolean'
    ) {
      out[key] = typeof raw === 'string' ? raw.slice(0, 300) : raw;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

router.post('/', clientLogLimiter, (req, res) => {
  const body = (req.body || {}) as Partial<ClientLogPayload>;
  const level = asLevel(body.level);
  const event = cleanString(body.event, 120) || 'frontend_log';
  const message = cleanString(body.message, 500);
  const path = cleanString(body.path, 300);
  const requestId = cleanString(body.requestId, 80);
  const fields = cleanFields(body.fields);

  logger[level]({
    requestId: req.requestId,
    clientRequestId: requestId,
    clientEvent: event,
    message,
    path,
    userId: req.auth?.user.id,
    householdId: req.auth?.household.id,
    ...fields,
  }, event);

  res.status(204).end();
});

export default router;
