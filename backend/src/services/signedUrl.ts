/**
 * HMAC-signed download URL helpers (issue #302).
 *
 * A download URL embeds two query parameters:
 *   exp=<unix-seconds>  — expiry epoch
 *   sig=<hex>           — HMAC-SHA256 of "<exportId>:<userId>:<exp>" keyed
 *                          with EXPORTS_URL_SECRET
 *
 * The signature binds the URL to a specific (exportId, userId) pair so a
 * signed URL issued to user A cannot be replayed by user B.
 */
import crypto from 'crypto';
import { getExportsUrlSecret } from '../config/dataExports';

function computeSignature(
  exportId: number,
  userId: number,
  exp: number,
  secret: string,
): string {
  const message = `${exportId}:${userId}:${exp}`;
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

/**
 * Build query params for a signed download URL.
 *
 * @param exportId - DataExport row id
 * @param userId   - Owner user id (signature is bound to this user)
 * @param expiresAt - Date after which the URL is invalid
 */
export function buildSignedParams(
  exportId: number,
  userId: number,
  expiresAt: Date,
): { exp: string; sig: string } {
  const exp = Math.floor(expiresAt.getTime() / 1000);
  const secret = getExportsUrlSecret();
  const sig = computeSignature(exportId, userId, exp, secret);
  return { exp: String(exp), sig };
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'expired' | 'invalid_signature' };

/**
 * Verify that `exp` and `sig` query params are valid for the given export /
 * user pair.
 */
export function verifySignedParams(
  exportId: number,
  userId: number,
  exp: string | undefined,
  sig: string | undefined,
): VerifyResult {
  if (!exp || !sig) {
    return { ok: false, reason: 'invalid_signature' };
  }

  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum <= 0) {
    return { ok: false, reason: 'invalid_signature' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (expNum < nowSec) {
    return { ok: false, reason: 'expired' };
  }

  const secret = getExportsUrlSecret();
  const expected = computeSignature(exportId, userId, expNum, secret);
  const match = crypto.timingSafeEqual(
    Buffer.from(sig, 'hex').length === expected.length / 2
      ? Buffer.from(sig, 'hex')
      : Buffer.alloc(1),
    Buffer.from(expected, 'hex'),
  );
  if (!match) {
    return { ok: false, reason: 'invalid_signature' };
  }

  return { ok: true };
}
