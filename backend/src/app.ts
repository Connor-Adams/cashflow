import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import * as env from './config/env';

import { mountRoutes, captureCors } from './routeRegistry';
import { attachAuth } from './auth/middleware';
import { csrfGuard } from './auth/csrf';
import { logger } from './observability/logger';
import { requestLogger } from './observability/requestLogger';
import { withContext } from './observability/requestContext';
import { ServerErrorEvent } from './models';

const app = express();

app.set('trust proxy', env.trustProxy);

app.get('/', (_req, res) => {
  res.json({
    service: 'cashflow-backend',
    health: '/api/health',
  });
});

// Apply the capture CORS allow-list BEFORE the global cors() middleware. The
// global middleware uses a static `origin: env.corsOrigin` (the frontend host)
// which rejects preflights from amazon.{com,ca,co.uk} / reportaproblem.apple.com
// before they ever reach the /api/capture/orders router. By mounting captureCors
// first on that exact path, the bookmarklet preflight gets the right
// Access-Control-Allow-Origin header.
app.use('/api/capture/orders', captureCors);

app.use(
  cors({
    origin: env.corsOrigin,
    credentials: true,
  })
);
app.use(requestLogger);
// CSRF defense (issue #825): reject cookie-authed cross-origin writes under /api
// via an Origin/Referer allow-list. Mounted before body parsing so a forged
// request is turned away before its payload is read; it self-exempts safe
// methods and any request without the session cookie (token-authed flows).
app.use('/api', csrfGuard);
app.use(express.json({ limit: '2mb' }));
app.use(attachAuth);
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.auth) {
    withContext(
      {
        userId: String(req.auth.user.id),
        householdId: String(req.auth.household.id),
        role: req.auth.role,
      },
      () => next(),
    );
  } else {
    next();
  }
});

// Router mounts live in a declarative, ordered registry (./routeRegistry).
// mountRoutes applies, in order: every pre-auth (public/token-authed) entry,
// then the `app.use('/api', requireAuth)` boundary, then every session-gated
// entry — reproducing the exact prior mount order, paths, middleware chains,
// and 410 stubs. The registry is the single source of truth for mount priority
// and the auth boundary; this file owns only the surrounding middleware
// pipeline and the terminal error handlers below.
mountRoutes(app);

type ErrorWithMetadata = {
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
};

const isObjectError = (err: unknown): err is ErrorWithMetadata =>
  Boolean(err) && typeof err === 'object';

const getErrorCode = (err: unknown): string =>
  isObjectError(err) && 'code' in err ? String(err.code) : '';

const getErrorStatus = (err: unknown, code: string): number => {
  if (code === 'LIMIT_FILE_SIZE') {
    return 400;
  }

  const rawStatus =
    isObjectError(err) && 'status' in err
      ? err.status
      : isObjectError(err) && 'statusCode' in err
        ? err.statusCode
        : undefined;
  const status = Number(rawStatus) || 500;

  return status >= 400 && status < 600 ? status : 500;
};

const getErrorMessage = (err: unknown): string => {
  if (err instanceof Error && err.message && !err.message.includes('ENOENT')) {
    return err.message;
  }

  return 'Internal Server Error';
};

app.use((err: unknown, req: Request, _res: Response, next: NextFunction) => {
  const status = (err as { status?: number })?.status ?? 500;
  if (status >= 500) {
    void ServerErrorEvent.create({
      householdId: req.auth?.household.id ?? req.auditAuth?.household.id ?? null,
      userId: req.auth?.user.id ?? req.auditAuth?.user.id ?? null,
      method: req.method,
      path: req.originalUrl.slice(0, 512),
      status,
      message: String((err as Error)?.message ?? '').slice(0, 4000),
      stack: String((err as Error)?.stack ?? '').slice(0, 8000),
      requestId: req.requestId ?? null,
    }).catch(() => undefined);
  }
  next(err);
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const code = getErrorCode(err);
  const responseStatus = getErrorStatus(err, code);
  const requestContext = {
    requestId: _req.requestId,
    method: _req.method,
    path: _req.originalUrl || _req.url,
    statusCode: responseStatus,
    userId: _req.auth?.user.id,
    householdId: _req.auth?.household.id,
  };
  if (responseStatus >= 500) {
    logger.error({ ...requestContext, err }, 'request_failed');
  } else {
    logger.warn({
      ...requestContext,
      errorName: err instanceof Error ? err.name : undefined,
      errorMessage: err instanceof Error ? err.message : undefined,
    }, 'request_failed');
  }
  if (code === 'LIMIT_FILE_SIZE') {
    res.status(400).json({ error: 'File too large (max 15MB)' });
    return;
  }

  res.status(responseStatus).json({
    error: getErrorMessage(err),
  });
});

export default app;
