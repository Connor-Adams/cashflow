import type { Request, Response, NextFunction } from 'express';
import { Op } from 'sequelize';
import { Household, HouseholdMember, Session, User } from '../models';
import { hashToken } from './password';
import './types';

export const SESSION_COOKIE = 'cashflow_session';

// Optional cookie Domain. Set SESSION_COOKIE_DOMAIN to a shared parent (e.g.
// `.example.com`) so the session cookie is first-party across the UI (`app.`)
// and API (`api.`) subdomains. Without it the cookie is host-only on the API
// host, making it a third-party cookie that Safari/iOS (WebKit ITP) drop —
// which breaks auth for cross-subdomain deployments. Unset → host-only (local).
function cookieDomainAttr(): string {
  const domain = process.env.SESSION_COOKIE_DOMAIN?.trim();
  return domain ? ` Domain=${domain};` : '';
}

// SameSite/Secure attributes for the session cookie.
//
// `SameSite=None` lets the cookie ride cross-site requests — necessary only for
// the cross-subdomain deployment where the UI (`app.`) and API (`api.`) are
// different hosts under a shared parent and SESSION_COOKIE_DOMAIN is set. When
// no cookie domain is configured the API is same-host with the UI, so
// `SameSite=Lax` is both sufficient and safer: it stops the cookie from being
// attached to cross-site state-changing requests, shrinking the CSRF attack
// surface (issue #825).
//
// In production the cookie is always `Secure` (served over HTTPS, and browsers
// reject `SameSite=None` without it); outside production we use `SameSite=Lax`
// without `Secure` so it works over plain http during local dev.
function sameSiteAttr(): string {
  if (process.env.NODE_ENV !== 'production') return 'SameSite=Lax';
  const crossSite = Boolean(process.env.SESSION_COOKIE_DOMAIN?.trim());
  return `${crossSite ? 'SameSite=None' : 'SameSite=Lax'}; Secure`;
}

function sessionCookieAttributes(expiresAt: Date): string {
  return `Path=/;${cookieDomainAttr()} HttpOnly; ${sameSiteAttr()}; Expires=${expiresAt.toUTCString()}`;
}

function expiredSessionCookieAttributes(): string {
  return `Path=/;${cookieDomainAttr()} HttpOnly; ${sameSiteAttr()}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${sessionCookieAttributes(expiresAt)}`
  );
}

export function clearSessionCookie(res: Response): void {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; ${expiredSessionCookieAttributes()}`
  );
}

export async function attachAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) {
      next();
      return;
    }
    const session = await Session.findOne({
      where: {
        tokenHash: hashToken(token),
        expiresAt: { [Op.gt]: new Date() },
      },
      include: [{ model: User, as: 'user' }],
    });
    const user = session?.get('user') as User | undefined;
    if (!session || !user) {
      next();
      return;
    }
    const membership = await HouseholdMember.findOne({
      where: { userId: user.id },
      include: [{ model: Household, as: 'household' }],
      order: [['id', 'ASC']],
    });
    const household = membership?.get('household') as Household | undefined;
    if (!membership || !household) {
      next();
      return;
    }
    req.auth = { user, household, role: membership.role };
    next();
  } catch (e) {
    next(e);
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

export function currentAuth(req: Request) {
  if (!req.auth) {
    const e = new Error('Authentication required') as Error & { status?: number };
    e.status = 401;
    throw e;
  }
  return req.auth;
}
