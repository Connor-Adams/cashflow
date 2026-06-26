import type { Request, Response, NextFunction } from 'express';
import { assertCorsOrigin } from '../config/env';
import { SESSION_COOKIE } from './middleware';

/** The frontend origin allowed to drive cookie-authed writes, read live from
 * the environment (mirrors config/env's parsing/default) so it tracks runtime
 * config rather than a value frozen at module load. */
function configuredCorsOrigin(): string {
  return assertCorsOrigin(process.env.CORS_ORIGIN);
}

function isProduction(): boolean {
  return (process.env.NODE_ENV || 'development') === 'production';
}

/**
 * CSRF defense for cookie-authed, state-changing /api requests (issue #825).
 *
 * The session cookie is delivered automatically by the browser on credentialed
 * cross-origin requests, so CORS alone does NOT stop a malicious site from
 * driving a state change (it only blocks *reading* the response). We enforce an
 * Origin/Referer allow-list on every mutating request that carries the session
 * cookie. Token-authed flows (bookmarklet capture, /api/v1 reporting, audit)
 * use Bearer tokens with `credentials: false`, never send the session cookie,
 * and are therefore exempt automatically — there is no ambient credential to
 * abuse.
 *
 * Safe methods (GET/HEAD/OPTIONS) are never checked: they are not state-changing
 * and OPTIONS preflights must pass for CORS to function.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Reduce a full URL (Origin value or a Referer) to its `scheme://host[:port]` origin. */
function toOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Set of origins permitted to make cookie-authed mutating requests. The
 * configured frontend origin (CORS_ORIGIN) is always allowed; in non-production
 * the common local dev hosts are allowed too so the Vite dev server (and direct
 * curl from localhost) keep working.
 */
export function allowedOrigins(
  corsOrigin: string = configuredCorsOrigin(),
): Set<string> {
  const origins = new Set<string>();
  const configured = toOrigin(corsOrigin);
  if (configured) origins.add(configured);
  if (!isProduction()) {
    origins.add('http://localhost:5173');
    origins.add('http://localhost:3001');
    origins.add('http://127.0.0.1:5173');
    origins.add('http://127.0.0.1:3001');
  }
  return origins;
}

export function isOriginAllowed(
  origin: string,
  corsOrigin: string = configuredCorsOrigin(),
): boolean {
  const normalized = toOrigin(origin);
  if (!normalized) return false;
  return allowedOrigins(corsOrigin).has(normalized);
}

function hasSessionCookie(cookieHeader: string | undefined): boolean {
  if (!cookieHeader) return false;
  // Match the cookie name as a whole token to avoid false positives on a
  // cookie whose name merely ends with SESSION_COOKIE.
  return cookieHeader
    .split(';')
    .some((part) => part.trim().split('=')[0] === SESSION_COOKIE);
}

export function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method.toUpperCase())) {
    next();
    return;
  }
  // Only requests that ride the ambient session cookie can be forged via CSRF.
  // Token-authed flows carry no cookie and are exempt.
  if (!hasSessionCookie(req.headers.cookie)) {
    next();
    return;
  }

  const originHeader =
    typeof req.headers.origin === 'string' ? req.headers.origin : '';
  const refererHeader =
    typeof req.headers.referer === 'string' ? req.headers.referer : '';
  const candidate = originHeader || refererHeader;

  // When an Origin/Referer is present we enforce the allow-list strictly: a
  // foreign value is the CSRF case and is rejected. A browser ALWAYS attaches
  // an `Origin` header to a cross-origin (and same-origin) state-changing
  // fetch/form submit, so every real attack carries one — that is exactly what
  // this allow-list blocks.
  //
  // When NO origin signal is present at all we allow the request. The only ways
  // to omit Origin on a mutating request are same-origin navigations the
  // browser chooses not to tag and non-browser clients (curl, native apps, the
  // supertest harness) — none of which is a cross-site forgery. The `SameSite`
  // cookie attribute (Lax by default here, see middleware.ts) is the backstop
  // that keeps the session cookie off cross-site requests, so this is not a
  // protection gap. (Rejecting on missing Origin would break legitimate
  // non-browser callers and same-origin edge cases for no real security gain.)
  if (candidate && !isOriginAllowed(candidate)) {
    res.status(403).json({ error: 'Cross-origin request blocked' });
    return;
  }
  next();
}
