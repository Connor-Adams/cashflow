import type { Request, Response, NextFunction } from 'express';
import { HouseholdMember, User, UserReportingToken, Household } from '../models';
import { hashReportingToken, isReportingTokenFormat } from './reportingToken';

export interface ReportingAuthContext {
  user: User;
  household: Household;
  token: UserReportingToken;
}

declare module 'express-serve-static-core' {
  interface Request {
    reportingAuth?: ReportingAuthContext;
  }
}

export async function reportingAuth(req: Request, res: Response, next: NextFunction) {
  try {
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Reporting tokens are read-only' });
      return;
    }
    const header = String(req.headers.authorization ?? '');
    const match = header.match(/^Bearer\s+(\S+)$/i);
    const plaintext = match?.[1] ?? '';
    if (!plaintext || !isReportingTokenFormat(plaintext)) {
      res.status(401).json({ error: 'Invalid reporting token' });
      return;
    }
    const token = await UserReportingToken.findOne({
      where: { tokenHash: hashReportingToken(plaintext) },
    });
    if (!token || token.revokedAt != null) {
      res.status(401).json({ error: 'Invalid reporting token' });
      return;
    }
    const user = await User.findByPk(token.userId);
    if (!user) {
      res.status(401).json({ error: 'Invalid reporting token' });
      return;
    }
    const membership = await HouseholdMember.findOne({
      where: { userId: user.id },
      include: [{ model: Household, as: 'household' }],
      order: [['id', 'ASC']],
    });
    const household = membership?.get('household') as Household | undefined;
    if (!membership || !household) {
      res.status(403).json({ error: 'Reporting token user has no household' });
      return;
    }
    void token.update({ lastUsedAt: new Date() }).catch(() => undefined);
    req.reportingAuth = { user, household, token };
    next();
  } catch (e) {
    next(e);
  }
}
