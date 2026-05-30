import crypto from 'crypto';

const TOKEN_PREFIX = 'cfa_';
const TOKEN_BYTES = 24;

export function mintAuditTokenPlaintext(): string {
  const random = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  return `${TOKEN_PREFIX}${random}`;
}

export function hashAuditToken(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

export function isAuditTokenFormat(value: string): boolean {
  return /^cfa_[A-Za-z0-9_-]{32}$/.test(value);
}

export function maskAuditToken(plaintext: string): string {
  if (plaintext.length < 10) return plaintext;
  return `${plaintext.slice(0, 7)}…${plaintext.slice(-3)}`;
}
