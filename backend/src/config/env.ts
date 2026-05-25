import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const backendRoot = path.join(__dirname, '..', '..');

export type EnvConfig = {
  csvUploadDir: string;
  databaseUrl: string | null;
  databasePath: string;
  port: number;
  trustProxy: boolean | number | string;
  defaultCurrency: string;
  corsOrigin: string;
  nodeEnv: string;
  alphaVantageApiKey: string | null;
  quoteProvider: string;
  logoDevToken: string | null;
  quoteSchedulerEnabled: boolean;
  quoteDailyBudget: number;
  quoteTickCron: string;
  quoteMinAgeHours: number;
  dividendReconcileEnabled: boolean;
  dividendDedupDays: number;
  forwardIncomeEnabled: boolean;
  forwardIncomeCron: string;
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

export function assertDatabaseUrl(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') {
    return null;
  }
  try {
    const url = new URL(raw);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw new Error('DATABASE_URL must be a valid postgres URL');
  }
  return raw;
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

export function parseTrustProxy(
  raw: string | undefined,
  nodeEnv: string = process.env.NODE_ENV || 'development'
): boolean | number | string {
  if (raw === undefined || raw === '') {
    return nodeEnv === 'production' ? 1 : false;
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  const numeric = Number(trimmed);
  if (Number.isInteger(numeric) && numeric >= 0) return numeric;
  return raw.trim();
}

export function loadEnvConfig(
  e: Record<string, string | undefined>
): EnvConfig {
  const csvUploadDir =
    e.CSV_UPLOAD_DIR || path.join(backendRoot, 'uploads', 'csv');

  const databaseUrl = assertDatabaseUrl(e.DATABASE_URL);
  const databasePath = assertDatabasePath(e.DATABASE_PATH, backendRoot);
  const port = parsePort(e.PORT);
  const defaultCurrency = e.DEFAULT_CURRENCY || 'CAD';
  const corsOrigin = assertCorsOrigin(e.CORS_ORIGIN);
  const nodeEnv = e.NODE_ENV || 'development';
  const trustProxy = parseTrustProxy(e.TRUST_PROXY, nodeEnv);
  const alphaVantageApiKey = e.ALPHA_VANTAGE_API_KEY?.trim() || null;
  const quoteProvider = e.QUOTE_PROVIDER?.trim() || 'alpha_vantage';
  const logoDevToken = e.LOGO_DEV_TOKEN?.trim() || null;
  const quoteSchedulerEnabled = parseQuoteSchedulerEnabled(
    e.QUOTE_SCHEDULER_ENABLED,
    nodeEnv,
    alphaVantageApiKey,
  );
  const quoteDailyBudget = parseQuoteDailyBudget(e.QUOTE_DAILY_BUDGET);
  const quoteTickCron = e.QUOTE_TICK_CRON?.trim() || '*/4 * * * *';
  const quoteMinAgeHours = parseQuoteMinAgeHours(e.QUOTE_MIN_AGE_HOURS);
  const dividendReconcileEnabled = parseDividendReconcileEnabled(
    e.DIVIDEND_RECONCILE_ENABLED,
    nodeEnv,
  );
  const dividendDedupDays = parseDividendDedupDays(e.DIVIDEND_DEDUP_DAYS);
  const forwardIncomeEnabled = parseForwardIncomeEnabled(e.FORWARD_INCOME_ENABLED, nodeEnv);
  const forwardIncomeCron = e.FORWARD_INCOME_CRON?.trim() || '0 2 * * *';

  return {
    csvUploadDir,
    databaseUrl,
    databasePath,
    port,
    trustProxy,
    defaultCurrency,
    corsOrigin,
    nodeEnv,
    alphaVantageApiKey,
    quoteProvider,
    logoDevToken,
    quoteSchedulerEnabled,
    quoteDailyBudget,
    quoteTickCron,
    quoteMinAgeHours,
    dividendReconcileEnabled,
    dividendDedupDays,
    forwardIncomeEnabled,
    forwardIncomeCron,
  };
}

const QUOTE_TRUTHY = new Set(['true', '1', 'yes']);
const QUOTE_FALSY = new Set(['false', '0', 'no']);

export function parseQuoteSchedulerEnabled(
  raw: string | undefined,
  nodeEnv: string,
  apiKey: string | null,
): boolean {
  const trimmed = raw?.trim().toLowerCase();
  if (trimmed && QUOTE_TRUTHY.has(trimmed)) return true;
  if (trimmed && QUOTE_FALSY.has(trimmed)) return false;
  if (nodeEnv === 'test') return false;
  return apiKey != null;
}

export function parseQuoteDailyBudget(raw: string | undefined): number {
  if (raw == null || raw.trim() === '') return 22;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 25) {
    throw new Error(
      `QUOTE_DAILY_BUDGET must be an integer between 1 and 25 (Alpha Vantage free tier ceiling), got: ${raw}`,
    );
  }
  return n;
}

export function parseQuoteMinAgeHours(raw: string | undefined): number {
  if (raw == null || raw.trim() === '') return 18;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 24 * 7) {
    throw new Error(
      `QUOTE_MIN_AGE_HOURS must be between 0 and 168, got: ${raw}`,
    );
  }
  return n;
}

export function parseDividendReconcileEnabled(
  raw: string | undefined,
  nodeEnv: string,
): boolean {
  const trimmed = raw?.trim().toLowerCase();
  if (trimmed && QUOTE_TRUTHY.has(trimmed)) return true;
  if (trimmed && QUOTE_FALSY.has(trimmed)) return false;
  // Default off in test so existing AV scheduler/backfill tests don't
  // silently pull HoldingSnapshot rows into InvestmentActivity.
  if (nodeEnv === 'test') return false;
  return true;
}

export function parseForwardIncomeEnabled(raw: string | undefined, nodeEnv: string): boolean {
  const trimmed = raw?.trim().toLowerCase();
  if (trimmed && QUOTE_TRUTHY.has(trimmed)) return true;
  if (trimmed && QUOTE_FALSY.has(trimmed)) return false;
  if (nodeEnv === 'test') return false;
  return true;
}

export function parseDividendDedupDays(raw: string | undefined): number {
  if (raw == null || raw.trim() === '') return 5;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 60) {
    throw new Error(
      `DIVIDEND_DEDUP_DAYS must be an integer between 0 and 60, got: ${raw}`,
    );
  }
  return n;
}

const resolved = loadEnvConfig(process.env as Record<string, string | undefined>);

export const csvUploadDir = resolved.csvUploadDir;
export const databaseUrl = resolved.databaseUrl;
export const databasePath = resolved.databasePath;
export const port = resolved.port;
export const trustProxy = resolved.trustProxy;
export const defaultCurrency = resolved.defaultCurrency;
export const corsOrigin = resolved.corsOrigin;
export const nodeEnv = resolved.nodeEnv;
export const alphaVantageApiKey = resolved.alphaVantageApiKey;
export const quoteProvider = resolved.quoteProvider;
export const logoDevToken = resolved.logoDevToken;
export const quoteSchedulerEnabled = resolved.quoteSchedulerEnabled;
export const quoteDailyBudget = resolved.quoteDailyBudget;
export const quoteTickCron = resolved.quoteTickCron;
export const quoteMinAgeHours = resolved.quoteMinAgeHours;
export const dividendReconcileEnabled = resolved.dividendReconcileEnabled;
export const dividendDedupDays = resolved.dividendDedupDays;
export const forwardIncomeEnabled = resolved.forwardIncomeEnabled;
export const forwardIncomeCron = resolved.forwardIncomeCron;

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const enrichmentRecurringMinSupport = parseIntEnv(
  'ENRICHMENT_RECURRING_MIN_SUPPORT',
  3,
);
export const enrichmentAmazonLinkThreshold = parseIntEnv(
  'ENRICHMENT_AMAZON_LINK_THRESHOLD',
  70,
);
export const enrichmentRefundWindowDays = parseIntEnv(
  'ENRICHMENT_REFUND_WINDOW_DAYS',
  60,
);
export const enrichmentTransferWindowDays = parseIntEnv(
  'ENRICHMENT_TRANSFER_WINDOW_DAYS',
  2,
);

const TRUTHY = new Set(['true', '1', 'yes']);
const FALSY = new Set(['false', '0', 'no']);
function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (TRUTHY.has(raw)) return true;
  if (FALSY.has(raw)) return false;
  return fallback;
}

/** Stage 8 ai-batch: enabled when set true AND OPENAI_API_KEY present. */
export const enrichmentAiEnabled = parseBoolEnv(
  'ENRICHMENT_AI_ENABLED',
  true,
);
export const enrichmentAiMaxMerchants = parseIntEnv(
  'ENRICHMENT_AI_MAX_MERCHANTS_PER_IMPORT',
  80,
);
export const enrichmentAiPerRowConcurrency = parseIntEnv(
  'ENRICHMENT_AI_PER_ROW_CONCURRENCY',
  4,
);

export const googleOauthClientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() || null;
export const googleOauthClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || null;
export const googleOauthRedirectUri =
  process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim() ||
  'http://localhost:3001/api/email/callback/google';
export const emailIntegrationEnabled = Boolean(
  googleOauthClientId && googleOauthClientSecret && process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY,
);
