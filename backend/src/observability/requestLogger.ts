// backend/src/observability/requestLogger.ts
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from './logger';
import { recordHttpRequest } from './metrics';
import { withContext } from './requestContext';

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
    recordHttpRequest({
      method: req.method,
      routePath: typeof req.route?.path === 'string' ? req.route.path : undefined,
      originalUrl: req.originalUrl || req.url,
      statusCode,
      durationMs,
    });
    const level: 'info' | 'warn' | 'error' =
      statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
    logger[level](
      {
        method: req.method,
        path: req.originalUrl || req.url,
        statusCode,
        durationMs: Math.round(durationMs),
        // requestId, userId, householdId, role are auto-attached via ALS mixin
      },
      'http_request',
    );
  });

  withContext(
    {
      requestId,
      route: req.route?.path,
    },
    () => next(),
  );
}
