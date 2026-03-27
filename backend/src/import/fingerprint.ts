import crypto from 'crypto';

export function hashContent(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function rowFingerprint(payload: {
  accountId: number;
  date: string;
  amount: number;
  currency: string;
  merchantClean: string;
  sourceReference: string | null;
}): string {
  const data = {
    accountId: payload.accountId,
    date: payload.date,
    amount: String(payload.amount),
    currency: String(payload.currency || '').toUpperCase(),
    merchantClean: String(payload.merchantClean || ''),
    sourceReference: payload.sourceReference || null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}
