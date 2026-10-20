import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { HouseholdMember, User, Household } from '../models';
import type { UserToken } from '../models/UserToken';
import { SCOPE_CONFIG, findTokenForAuth, type TokenScope } from './scopedToken';

export interface TokenAuthContext {
  user: User;
  household: Household;
  token: UserToken;
}

/**
 * Each scope writes its own request key, so a reporting route can only ever
 * read `req.reportingAuth` — an audit-authed request leaves it undefined.
 */
const CONTEXT_KEY = {
  audit: 'auditAuth',
  reporting: 'reportingAuth',
  capture: 'captureAuth',
} as const satisfies Record<TokenScope, string>;

declare module 'express-serve-static-core' {
  interface Request {
    auditAuth?: TokenAuthContext;
    reportingAuth?: TokenAuthContext;
    captureAuth?: TokenAuthContext;
  }
}

type Outcome = { ok: true; ctx: TokenAuthContext } | { ok: false; status: number; error: string };

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The household a token acts on: the owner's first (oldest) membership. */
async function primaryHousehold(userId: number): Promise<Household | null> {
  const row = await HouseholdMember.findOne({
    where: { userId },
    order: [['id', 'ASC']],
    include: [{ model: Household, as: 'household' }],
  });
  return (row?.get('household') as Household | undefined) ?? null;
}

function bearerToken(header: string | undefined): string {
  return String(header ?? '').match(/^Bearer\s+(\S+)$/i)?.[1] ?? '';
}

function refusal(scope: TokenScope, status: number, template: (Noun: string) => string): Outcome {
  return { ok: false, status, error: template(capitalize(SCOPE_CONFIG[scope].noun)) };
}

const invalidToken = (scope: TokenScope) => refusal(scope, 401, (N) => `Invalid ${N.toLowerCase()} token`);

async function resolveOwner(scope: TokenScope, token: UserToken): Promise<Outcome> {
  const user = await User.findByPk(token.userId);
  if (!user) return invalidToken(scope);
  const household = await primaryHousehold(user.id);
  if (!household) return refusal(scope, 403, (N) => `${N} token user has no household`);
  return { ok: true, ctx: { user, household, token } };
}

async function resolveTokenContext(scope: TokenScope, header: string | undefined): Promise<Outcome> {
  const found = await findTokenForAuth(scope, bearerToken(header));
  if (found.ok) return resolveOwner(scope, found.token);
  return found.reason === 'expired'
    ? refusal(scope, 401, (N) => `${N} token has expired — mint a new one`)
    : invalidToken(scope);
}

/**
 * Bearer-token auth for one scope. Accepts only `Authorization: Bearer <prefix>…`
 * with that scope's prefix AND a row minted for that scope, so an audit token
 * can never open /api/v1 (and vice versa). Read-only scopes answer any
 * non-GET with 405 before touching the DB. On success the context lands on
 * the scope's own request key and last_used_at is touched best-effort.
 */
export function requireTokenAuth(scope: TokenScope): RequestHandler {
  const { readOnly, noun } = SCOPE_CONFIG[scope];
  const key = CONTEXT_KEY[scope];

  const rejectsMethod = (method: string) => readOnly && method !== 'GET';

  return async (req: Request, res: Response, next: NextFunction) => {
    if (rejectsMethod(req.method)) {
      res.status(405).json({ error: `${capitalize(noun)} tokens are read-only` });
      return;
    }
    try {
      const outcome = await resolveTokenContext(scope, req.headers.authorization);
      if (!outcome.ok) {
        res.status(outcome.status).json({ error: outcome.error });
        return;
      }
      void outcome.ctx.token.update({ lastUsedAt: new Date() }).catch(() => undefined);
      req[key] = outcome.ctx;
      next();
    } catch (e) {
      next(e);
    }
  };
}
