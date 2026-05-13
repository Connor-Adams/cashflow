import crypto from 'crypto';
import type { StatementPreview } from './statementTypes';

const TTL_MS = 30 * 60 * 1000;
const previews = new Map<string, { expiresAt: number; preview: StatementPreview }>();

function sweepExpired(now = Date.now()): void {
  for (const [key, row] of previews) {
    if (row.expiresAt <= now) previews.delete(key);
  }
}

export function saveStatementPreview(preview: Omit<StatementPreview, 'previewToken'>): StatementPreview {
  sweepExpired();
  const previewToken = crypto.randomBytes(24).toString('hex');
  const withToken: StatementPreview = { ...preview, previewToken };
  previews.set(previewToken, {
    expiresAt: Date.now() + TTL_MS,
    preview: withToken,
  });
  return withToken;
}

export function getStatementPreview(previewToken: string): StatementPreview | null {
  sweepExpired();
  const row = previews.get(previewToken);
  return row?.preview ?? null;
}

export function consumeStatementPreview(previewToken: string): StatementPreview | null {
  const row = getStatementPreview(previewToken);
  previews.delete(previewToken);
  return row;
}
