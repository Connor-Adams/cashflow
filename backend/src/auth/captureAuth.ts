import type { Request, Response, NextFunction } from 'express';
import { HouseholdMember, User, UserCaptureToken, Household } from '../models';
import { hashCaptureToken, isCaptureTokenFormat, isCaptureTokenExpired } from './captureToken';

export interface CaptureAuthContext {
  user: User;
  household: Household;
  token: UserCaptureToken;
}

declare module 'express-serve-static-core' {
  interface Request {
    captureAuth?: CaptureAuthContext;
  }
}

export async function captureAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const header = String(req.headers.authorization ?? '');
    const match = header.match(/^Bearer\s+(\S+)$/i);
    const plaintext = match?.[1] ?? '';
    if (!plaintext || !isCaptureTokenFormat(plaintext)) {
      res.status(401).json({ error: 'Invalid capture token' });
      return;
    }
    const token = await UserCaptureToken.findOne({ where: { tokenHash: hashCaptureToken(plaintext) } });
    if (!token || token.revokedAt != null) {
      res.status(401).json({ error: 'Invalid capture token' });
      return;
    }
    if (isCaptureTokenExpired(token.expiresAt)) {
      res.status(401).json({ error: 'Capture token has expired — mint a new one' });
      return;
    }
    const user = await User.findByPk(token.userId);
    if (!user) {
      res.status(401).json({ error: 'Invalid capture token' });
      return;
    }
    const membership = await HouseholdMember.findOne({
      where: { userId: user.id },
      include: [{ model: Household, as: 'household' }],
      order: [['id', 'ASC']],
    });
    const household = membership?.get('household') as Household | undefined;
    if (!membership || !household) {
      res.status(403).json({ error: 'Capture token user has no household' });
      return;
    }
    // Best-effort touch — never fail the request if this errors.
    void token.update({ lastUsedAt: new Date() }).catch(() => undefined);
    req.captureAuth = { user, household, token };
    next();
  } catch (e) {
    next(e);
  }
}
