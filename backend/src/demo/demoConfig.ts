import { randomBytes } from 'node:crypto';

const TRUTHY = new Set(['true', '1', 'yes']);
const FALSY = new Set(['false', '0', 'no']);

/**
 * Decide whether the demo account / `POST /api/auth/demo-login` is available.
 *
 * Security default (#817): demo login issues a real authenticated session with
 * no credential check, so it must be *opt-in* and never on by accident in a
 * production deploy. Resolution order:
 *   1. Explicit `DEMO_ACCOUNT_ENABLED=true|1|yes`  → enabled (any environment).
 *   2. Explicit `DEMO_ACCOUNT_ENABLED=false|0|no`  → disabled (any environment).
 *   3. Unset → enabled only when NOT in production (local dev / preview keep the
 *      one-click demo). A production deploy that forgets to set the flag now
 *      defaults OFF instead of exposing the seeded household.
 */
export function isDemoEnabled(
  raw: string | undefined,
  nodeEnv: string | undefined,
): boolean {
  const trimmed = raw?.trim().toLowerCase();
  if (trimmed && TRUTHY.has(trimmed)) return true;
  if (trimmed && FALSY.has(trimmed)) return false;
  return (nodeEnv || 'development') !== 'production';
}

/**
 * Resolve the demo account password without ever shipping a hardcoded one (#817).
 *
 * When `DEMO_ACCOUNT_PASSWORD` is configured we use it verbatim. When it is not,
 * we mint a fresh random password instead of falling back to a well-known
 * constant. `demo-login` issues the session directly (it does not verify this
 * password), so an unknown random value is harmless for the demo flow while
 * guaranteeing no production-capable build carries a guessable credential.
 */
export function resolveDemoPassword(raw: string | undefined): string {
  if (raw && raw.trim() !== '') return raw;
  return randomBytes(24).toString('base64url');
}
