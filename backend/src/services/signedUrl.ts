import { createHmac } from 'node:crypto';
import * as env from '../config/env';

const EXPORT_URL_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function sign(payload: string): string {
  return createHmac('sha256', env.exportSigningSecret).update(payload).digest('hex');
}

/** Create a signed query string for a data export download URL. */
export function mintExportDownloadParams(exportId: number, userId: number): { exp: string; sig: string } {
  const exp = Math.floor(Date.now() / 1000) + EXPORT_URL_TTL_SECONDS;
  const sig = sign(`${exportId}:${exp}:${userId}`);
  return { exp: String(exp), sig };
}

/** Verify signed export download params. Returns false if invalid or expired. */
export function verifyExportDownloadParams(
  exportId: number,
  userId: number,
  exp: string,
  sig: string,
): boolean {
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Math.floor(Date.now() / 1000)) return false;
  const expected = sign(`${exportId}:${exp}:${userId}`);
  return expected === sig;
}
