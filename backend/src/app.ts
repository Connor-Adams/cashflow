import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import * as env from './config/env';

import { mountRoutes, captureCors } from './routeRegistry';
import { noStore } from './http/noStore';
import { attachAuth } from './auth/middleware';
import { csrfGuard } from './auth/csrf';
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

// Security headers (issue #819). This is a JSON + file-download API consumed by
// a separate-origin SPA, so we lean on helmet's safe defaults but tune two
// things for the cross-origin frontend:
//  - `X-Content-Type-Options: nosniff` (helmet default) is the core fix — it
//    stops content-sniffing browsers from rendering attacker-controlled upload
//    bytes (vault/receipt downloads) as HTML on the app origin (stored XSS).
//  - A locked-down CSP. The API never returns HTML it wants a browser to
//    render, so `default-src 'none'` is the tightest correct policy; it also
//    neutralizes any HTML that does slip through (e.g. an error page).
//  - `Cross-Origin-Resource-Policy: cross-origin` so the SPA on its own origin
//    can still fetch API responses (the helmet default `same-origin` would
//    block legitimate cross-origin XHR/fetch from the frontend host).
//  - `X-Frame-Options: DENY` (issue #853): the API must never be framed. helmet's
//    default is SAMEORIGIN; DENY is strictly tighter and matches the CSP
//    `frame-ancestors 'none'` authority for legacy browsers without CSP support.
//  - `Referrer-Policy: no-referrer` (helmet default, issue #853): full request
//    URLs (resource ids, any token query params) must not leak via `Referer` to
//    third-party resources (logo.dev, external images).
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'frame-ancestors': ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    frameguard: { action: 'deny' },
  }),
);

// Global no-store for the entire /api surface (issue #853). Financial PII must
// never be persisted to a browser/proxy cache. Mounted before the routers so a
// streaming handler can still override with `no-store, no-transform`.
app.use('/api', noStore);

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
