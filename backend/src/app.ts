import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import * as env from './config/env';

import { mountRoutes, captureCors } from './routeRegistry';
import { attachAuth } from './auth/middleware';
import { logger } from './observability/logger';
import { requestLogger } from './observability/requestLogger';
import { withContext } from './observability/requestContext';
import {
  getErrorCode,
  getErrorStatus,
  getClientErrorMessage,
} from './http/errorResponse';
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
    error: getClientErrorMessage(err, responseStatus),
  });
});

export default app;
