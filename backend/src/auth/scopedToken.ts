import crypto from 'crypto';
import { Op } from 'sequelize';
import { UserToken, type TokenScope } from '../models/UserToken';

export type { TokenScope } from '../models/UserToken';
export { TOKEN_SCOPES } from '../models/UserToken';

const TOKEN_BYTES = 24; // 32 chars after base64url

/**
 * Capture tokens expire 90 days after minting (issue #829). The token rides in
 * cleartext inside the bookmarklet `javascript:` URL stored in the browser's
 * bookmark store, so a leaked bookmark previously granted POST
 * /api/capture/orders forever. A TTL bounds the blast radius of a leak; the
 * Settings UI surfaces the expiry and prompts a re-mint.
 */
export const CAPTURE_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

interface ScopeConfig {
  /** Plaintext prefix — lets a token's scope be read (and refused) before any DB hit. */
  prefix: string;
  /** Label used when the mint request omits one. */
  defaultLabel: string;
  /** Lifetime of a newly minted token; null = no expiry. */
  ttlMs: number | null;
  /** GET-only surface: the auth middleware answers any other method with 405. */
  readOnly: boolean;
  /** Human noun used in error messages ("Invalid audit token"). */
  noun: string;
}

export const SCOPE_CONFIG: Record<TokenScope, ScopeConfig> = {
  audit: { prefix: 'cfa_', defaultLabel: 'Audit', ttlMs: null, readOnly: true, noun: 'audit' },
  reporting: { prefix: 'cfr_', defaultLabel: 'Reporting', ttlMs: null, readOnly: true, noun: 'reporting' },
  capture: {
    prefix: 'cfc_',
    defaultLabel: 'Browser',
    ttlMs: CAPTURE_TOKEN_TTL_MS,
    readOnly: false,
    noun: 'capture',
  },
};

export function mintTokenPlaintext(scope: TokenScope): string {
  const random = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  return `${SCOPE_CONFIG[scope].prefix}${random}`;
}

/** SHA-256 hex of the full plaintext (prefix included) — what the DB stores. */
export function hashScopedToken(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

export function isTokenFormat(scope: TokenScope, value: string): boolean {
  const { prefix } = SCOPE_CONFIG[scope];
  return value.startsWith(prefix) && /^[A-Za-z0-9_-]{32}$/.test(value.slice(prefix.length));
}

/** Expiry instant for a `scope` token minted at `from`, or null if the scope never expires. */
export function tokenExpiry(scope: TokenScope, from: Date = new Date()): Date | null {
  const { ttlMs } = SCOPE_CONFIG[scope];
  return ttlMs == null ? null : new Date(from.getTime() + ttlMs);
}

/** A token is expired when it carries an `expiresAt` in the past. */
export function isTokenExpired(expiresAt: Date | null, now: Date = new Date()): boolean {
  return expiresAt != null && expiresAt.getTime() <= now.getTime();
}

export async function issueToken(
  userId: number,
  scope: TokenScope,
  label: string,
): Promise<{ row: UserToken; plaintext: string }> {
  const plaintext = mintTokenPlaintext(scope);
  const row = await UserToken.create({
    userId,
    scope,
    tokenHash: hashScopedToken(plaintext),
    label,
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: tokenExpiry(scope),
  });
  return { row, plaintext };
}

export function listActiveTokens(userId: number, scope: TokenScope): Promise<UserToken[]> {
  return UserToken.findAll({
    where: { userId, scope, revokedAt: { [Op.is]: null } },
    order: [['createdAt', 'DESC']],
  });
}

/** Revoke one of the user's tokens in `scope`. Idempotent; false when no such token. */
export async function revokeToken(userId: number, scope: TokenScope, id: number): Promise<boolean> {
  const row = await UserToken.findOne({ where: { id, userId, scope } });
  if (!row) return false;
  if (row.revokedAt == null) await row.update({ revokedAt: new Date() });
  return true;
}

/** Revoke every live token the user holds, across all scopes. */
export async function revokeAllTokensForUser(userId: number, now: Date = new Date()): Promise<void> {
  await UserToken.update({ revokedAt: now }, { where: { userId, revokedAt: null } });
}

export type TokenLookup = { ok: true; token: UserToken } | { ok: false; reason: 'invalid' | 'expired' };

function classifyToken(token: UserToken | null): TokenLookup {
  if (!token || token.revokedAt != null) return { ok: false, reason: 'invalid' };
  if (isTokenExpired(token.expiresAt)) return { ok: false, reason: 'expired' };
  return { ok: true, token };
}

/** Resolve a bearer plaintext to its live token row in `scope`, or a refusal reason. */
export async function findTokenForAuth(scope: TokenScope, plaintext: string): Promise<TokenLookup> {
  if (!isTokenFormat(scope, plaintext)) return { ok: false, reason: 'invalid' };
  // `scope` in the WHERE is the second wall behind the prefix check: a row
  // minted for one scope can never satisfy another scope's lookup.
  return classifyToken(await UserToken.findOne({ where: { scope, tokenHash: hashScopedToken(plaintext) } }));
}
