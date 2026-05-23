import crypto from 'crypto';

const TOKEN_PREFIX = 'cfc_';
const TOKEN_BYTES = 24; // 32 chars after base64url

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

export function maskCaptureToken(plaintext: string): string {
  if (plaintext.length < 10) return plaintext;
  return `${plaintext.slice(0, 7)}…${plaintext.slice(-3)}`;
}
