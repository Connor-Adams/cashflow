import type { Request, Response, NextFunction } from 'express';
import { Op } from 'sequelize';
import { Household, HouseholdMember, Session, User } from '../models';
import { hashToken } from './password';
import './types';

export const SESSION_COOKIE = 'cashflow_session';

function sessionCookieAttributes(expiresAt: Date): string {
  const sameSite =
    process.env.NODE_ENV === 'production' ? 'SameSite=None; Secure' : 'SameSite=Lax';
  return `Path=/; HttpOnly; ${sameSite}; Expires=${expiresAt.toUTCString()}`;
}

function expiredSessionCookieAttributes(): string {
  const sameSite =
    process.env.NODE_ENV === 'production' ? 'SameSite=None; Secure' : 'SameSite=Lax';
  return `Path=/; HttpOnly; ${sameSite}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
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
