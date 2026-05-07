import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from './logger';

function headerValue(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const requestId = headerValue(req, 'x-request-id') || randomUUID();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const statusCode = res.statusCode;
    const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
    logger[level]('http_request', {
      requestId,
      method: req.method,
      path: req.originalUrl || req.url,
      statusCode,
      durationMs: Math.round(durationMs),
      userId: req.auth?.user.id,
      householdId: req.auth?.household.id,
      role: req.auth?.role,
    });
  });

  next();
}
