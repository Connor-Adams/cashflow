import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const backendRoot = path.join(__dirname, '..', '..');

export type EnvConfig = {
  csvUploadDir: string;
  databasePath: string;
  port: number;
  defaultCurrency: string;
  corsOrigin: string;
  nodeEnv: string;
};

export function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return 3001;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got: ${raw}`);
  }
  return n;
}

export function assertDatabasePath(
  raw: string | undefined,
  backendRootDir: string
): string {
  if (raw === undefined) {
    return path.join(backendRootDir, 'data', 'cashflow.sqlite');
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new Error('DATABASE_PATH cannot be empty when set');
  }
  return raw.trim();
}

export function assertCorsOrigin(raw: string | undefined): string {
  if (raw === undefined || raw === '') {
    return 'http://localhost:5173';
  }
  try {
    // eslint-disable-next-line no-new -- URL validation only
    new URL(raw);
  } catch {
    throw new Error(`CORS_ORIGIN must be a valid URL, got: ${raw}`);
  }
  return raw;
}

export function loadEnvConfig(
  e: Record<string, string | undefined>
): EnvConfig {
  const csvUploadDir =
    e.CSV_UPLOAD_DIR || path.join(backendRoot, 'uploads', 'csv');

  const databasePath = assertDatabasePath(e.DATABASE_PATH, backendRoot);
  const port = parsePort(e.PORT);
  const defaultCurrency = e.DEFAULT_CURRENCY || 'CAD';
  const corsOrigin = assertCorsOrigin(e.CORS_ORIGIN);
  const nodeEnv = e.NODE_ENV || 'development';

  return {
    csvUploadDir,
    databasePath,
    port,
    defaultCurrency,
    corsOrigin,
    nodeEnv,
  };
}

const resolved = loadEnvConfig(process.env as Record<string, string | undefined>);

export const csvUploadDir = resolved.csvUploadDir;
export const databasePath = resolved.databasePath;
export const port = resolved.port;
export const defaultCurrency = resolved.defaultCurrency;
export const corsOrigin = resolved.corsOrigin;
export const nodeEnv = resolved.nodeEnv;
