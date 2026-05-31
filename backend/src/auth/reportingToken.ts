import crypto from 'crypto';

const TOKEN_PREFIX = 'cfr_';
const TOKEN_BYTES = 24; // 32 chars after base64url

export function mintReportingTokenPlaintext(): string {
  const random = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  return `${TOKEN_PREFIX}${random}`;
}

export function hashReportingToken(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

export function isReportingTokenFormat(value: string): boolean {
  return /^cfr_[A-Za-z0-9_-]{32}$/.test(value);
}

export function maskReportingToken(plaintext: string): string {
  if (plaintext.length < 10) return plaintext;
  return `${plaintext.slice(0, 7)}…${plaintext.slice(-3)}`;
}
