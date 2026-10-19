import { Router, type Response } from 'express';
import type { UserToken } from '../models/UserToken';
import { currentAuth, requireAuth } from '../auth/middleware';
import { SCOPE_CONFIG, issueToken, listActiveTokens, revokeToken, type TokenScope } from '../auth/scopedToken';

const MAX_LABEL = 64;

/** Trimmed label, the scope default when blank, or null when too long. */
function rawLabel(body: unknown): string {
  return String((body as { label?: unknown } | undefined)?.label ?? '').trim();
}

function parseLabel(body: unknown, fallback: string): string | null {
  const label = rawLabel(body) || fallback;
  return label.length > MAX_LABEL ? null : label;
}

/** Positive integer route id, or null. */
function parseTokenId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id >= 1 ? id : null;
}

function fail(res: Response, status: number, error: string): void {
  res.status(status).json({ error });
}

/**
 * Session-authed mint / list / revoke for one token scope. Mounted at
 * /api/audit/tokens, /api/v1/tokens and /api/capture/tokens. Response shapes
 * are the pre-fold ones: `expiresAt` appears only for scopes that expire
 * (capture), and plaintext only in the mint response.
 */
export function createScopedTokenRouter(scope: TokenScope): Router {
  const { defaultLabel, ttlMs } = SCOPE_CONFIG[scope];
  const expiry = (row: UserToken) => (ttlMs == null ? {} : { expiresAt: row.expiresAt });
  const summary = (row: UserToken) => ({
    id: row.id,
    label: row.label,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    ...expiry(row),
  });

  const router = Router();
  router.use(requireAuth);

  router.post('/', async (req, res, next) => {
    try {
      const label = parseLabel(req.body, defaultLabel);
      if (label == null) return fail(res, 400, `Label must be ${MAX_LABEL} characters or fewer`);
      const { row, plaintext } = await issueToken(currentAuth(req).user.id, scope, label);
      res.status(201).json({ id: row.id, plaintext, label: row.label, createdAt: row.createdAt, ...expiry(row) });
    } catch (e) {
      next(e);
    }
  });

  router.get('/', async (req, res, next) => {
    try {
      const rows = await listActiveTokens(currentAuth(req).user.id, scope);
      res.json(rows.map(summary));
    } catch (e) {
      next(e);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const id = parseTokenId(req.params.id);
      if (id == null) return fail(res, 400, 'Invalid id');
      const found = await revokeToken(currentAuth(req).user.id, scope, id);
      if (!found) return fail(res, 404, 'Token not found');
      res.status(204).send();
    } catch (e) {
      next(e);
    }
  });

  return router;
}
