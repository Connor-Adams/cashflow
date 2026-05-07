import type { Request, Response, NextFunction } from 'express';
import { Op } from 'sequelize';
import { Household, HouseholdMember, Session, User } from '../models';
import { hashToken } from './password';
import './types';

export const SESSION_COOKIE = 'cashflow_session';

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
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expiresAt.toUTCString()}${secure}`
  );
}

export function clearSessionCookie(res: Response): void {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
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
