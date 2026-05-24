import crypto from 'crypto';

export function hashContent(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function rowFingerprint(payload: {
  accountId: number;
  date: string;
  amount: number;
  currency: string;
  merchantRaw: string;
  sourceReference: string | null;
}): string {
  const data = {
    accountId: payload.accountId,
    date: payload.date,
    amount: String(payload.amount),
    currency: String(payload.currency || '').toUpperCase(),
    merchantRaw: String(payload.merchantRaw || ''),
    sourceReference: payload.sourceReference || null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

/**
 * Hash over only the bank-stable identity of a transaction: account, date,
 * amount, currency, merchantRaw. Deliberately excludes both `merchantClean`
 * (drifts as normalizeMerchant evolves) and `sourceReference` (Amex flips
 * NULL → AT… when txns leave the ~30-day pending window). Becomes the
 * primary dedup key in `findExistingForDedup`; the legacy
 * `sourceRowFingerprint` and its unique index remain as an audit hash /
 * safety net.
 */
export function stableIdentityFingerprint(payload: {
  accountId: number;
  date: string;
  amount: number;
  currency: string;
  merchantRaw: string;
}): string {
  const data = {
    accountId: payload.accountId,
    date: payload.date,
    amount: String(payload.amount),
    currency: String(payload.currency || '').toUpperCase(),
    merchantRaw: String(payload.merchantRaw || ''),
  };
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

export function stableFingerprint(payload: Record<string, unknown>): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}
