import type { Request, Response, NextFunction } from 'express';
import { HouseholdMember, User, UserAuditToken, Household } from '../models';
import { hashAuditToken, isAuditTokenFormat } from './auditToken';

export interface AuditAuthContext {
  user: User;
  household: Household;
  token: UserAuditToken;
}

declare module 'express-serve-static-core' {
  interface Request {
    auditAuth?: AuditAuthContext;
  }
}

export async function requireAuditAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Audit surface is read-only (GET only)' });
      return;
    }
    const header = String(req.headers.authorization ?? '');
    const match = header.match(/^Bearer\s+(\S+)$/i);
    const plaintext = match?.[1] ?? '';
    if (!plaintext || !isAuditTokenFormat(plaintext)) {
      res.status(401).json({ error: 'Invalid audit token' });
      return;
    }
    const token = await UserAuditToken.findOne({
      where: { tokenHash: hashAuditToken(plaintext) },
    });
    if (!token || token.revokedAt != null) {
      res.status(401).json({ error: 'Invalid audit token' });
      return;
    }
    const user = await User.findByPk(token.userId);
    if (!user) {
      res.status(401).json({ error: 'Invalid audit token' });
      return;
    }
    const membership = await HouseholdMember.findOne({
      where: { userId: user.id },
      include: [{ model: Household, as: 'household' }],
      order: [['id', 'ASC']],
    });
    const household = membership?.get('household') as Household | undefined;
    if (!membership || !household) {
      res.status(403).json({ error: 'Audit token user has no household' });
      return;
    }
    void token.update({ lastUsedAt: new Date() }).catch(() => undefined);
    req.auditAuth = { user, household, token };
    next();
  } catch (e) {
    next(e);
  }
}
