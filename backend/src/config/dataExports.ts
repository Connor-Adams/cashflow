import path from 'path';

const backendRoot = path.join(__dirname, '..', '..');

/**
 * Directory where data export ZIPs are stored (issue #302).
 * Overridable via EXPORTS_DIR env var; defaults to
 * `<backendRoot>/uploads/exports`.
 */
export function getExportsDir(): string {
  return (
    process.env.EXPORTS_DIR?.trim() ||
    path.join(backendRoot, 'uploads', 'exports')
  );
}

/**
 * Hmac signing secret for download URLs (issue #302).
 * Defaults to SESSION_SECRET or a hard-coded dev fallback.
 * In production, set EXPORTS_URL_SECRET to an independent secret.
 */
export function getExportsUrlSecret(): string {
  return (
    process.env.EXPORTS_URL_SECRET?.trim() ||
    process.env.SESSION_SECRET?.trim() ||
    'dev-exports-secret-change-in-production'
  );
}

/** Export ZIP TTL in milliseconds (7 days). */
export const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Soft limit for a single export job in milliseconds (1 hour). */
export const EXPORT_JOB_SOFT_LIMIT_MS = 60 * 60 * 1000;
