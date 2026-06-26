import crypto from 'crypto';

const TOKEN_PREFIX = 'cfc_';
const TOKEN_BYTES = 24; // 32 chars after base64url

/**
 * Capture tokens expire 90 days after minting (issue #829). The token rides in
 * cleartext inside the bookmarklet `javascript:` URL stored in the browser's
 * bookmark store, so a leaked bookmark previously granted POST
 * /api/capture/orders forever. A TTL bounds the blast radius of a leak; the
 * Settings UI surfaces the expiry and prompts a re-mint.
 */
export const CAPTURE_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Expiry instant for a token minted at `from` (default: now). */
export function captureTokenExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + CAPTURE_TOKEN_TTL_MS);
}

/** A token is expired when it carries an `expiresAt` in the past. */
export function isCaptureTokenExpired(expiresAt: Date | null, now: Date = new Date()): boolean {
  return expiresAt != null && expiresAt.getTime() <= now.getTime();
}

export function mintCaptureTokenPlaintext(): string {
  const random = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  return `${TOKEN_PREFIX}${random}`;
}

export function hashCaptureToken(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

export function isCaptureTokenFormat(value: string): boolean {
  return /^cfc_[A-Za-z0-9_-]{32}$/.test(value);
}
