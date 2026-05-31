import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const backendRoot = path.join(__dirname, '..', '..');

export type EnvConfig = {
  csvUploadDir: string;
  changelogDir: string;
  databaseUrl: string | null;
  databasePath: string;
  port: number;
  trustProxy: boolean | number | string;
  defaultCurrency: string;
  corsOrigin: string;
  nodeEnv: string;
  logoDevToken: string | null;
  quoteSchedulerEnabled: boolean;
  quoteTickCron: string;
  quoteMinAgeHours: number;
  dividendReconcileEnabled: boolean;
  dividendDedupDays: number;
  forwardIncomeEnabled: boolean;
  forwardIncomeCron: string;
  dailySnapshotEnabled: boolean;
  dailySnapshotCron: string;
  enrichmentBackfillEnabled: boolean;
  enrichmentBackfillCron: string;
  weeklyDigestEnabled: boolean;
  weeklyDigestCron: string;
  budgetBreachCheckEnabled: boolean;
  budgetBreachCheckCron: string;
  dividendMatchEnabled: boolean;
  dividendMatchCron: string;
  subscriptionPriceDetectEnabled: boolean;
  subscriptionPriceDetectCron: string;
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
  const changelogDir =
    e.CHANGELOG_DIR || path.join(backendRoot, '..', 'docs', 'changelog');

  const databaseUrl = assertDatabaseUrl(e.DATABASE_URL);
  const databasePath = assertDatabasePath(e.DATABASE_PATH, backendRoot);
  const port = parsePort(e.PORT);
  const defaultCurrency = e.DEFAULT_CURRENCY || 'CAD';
  const corsOrigin = assertCorsOrigin(e.CORS_ORIGIN);
  const nodeEnv = e.NODE_ENV || 'development';
  const trustProxy = parseTrustProxy(e.TRUST_PROXY, nodeEnv);
  const logoDevToken = e.LOGO_DEV_TOKEN?.trim() || null;
  const quoteSchedulerEnabled = parseQuoteSchedulerEnabled(
    e.QUOTE_SCHEDULER_ENABLED,
    nodeEnv,
  );
  const quoteTickCron = e.QUOTE_TICK_CRON?.trim() || '*/4 * * * *';
  const quoteMinAgeHours = parseQuoteMinAgeHours(e.QUOTE_MIN_AGE_HOURS);
  const dividendReconcileEnabled = parseDividendReconcileEnabled(
    e.DIVIDEND_RECONCILE_ENABLED,
    nodeEnv,
  );
  const dividendDedupDays = parseDividendDedupDays(e.DIVIDEND_DEDUP_DAYS);
  const forwardIncomeEnabled = parseForwardIncomeEnabled(e.FORWARD_INCOME_ENABLED, nodeEnv);
  const forwardIncomeCron = e.FORWARD_INCOME_CRON?.trim() || '0 2 * * *';
  const dailySnapshotEnabled = parseDailySnapshotEnabled(e.DAILY_SNAPSHOT_ENABLED, nodeEnv);
  const dailySnapshotCron = e.DAILY_SNAPSHOT_CRON?.trim() || '0 3 * * *';
  const enrichmentBackfillEnabled = parseEnrichmentBackfillEnabled(
    e.ENRICHMENT_BACKFILL_ENABLED,
    nodeEnv,
  );
  const enrichmentBackfillCron = e.ENRICHMENT_BACKFILL_CRON?.trim() || '0 4 * * *';
  const weeklyDigestEnabled = parseWeeklyDigestEnabled(
    e.WEEKLY_DIGEST_ENABLED,
    nodeEnv,
  );
  const weeklyDigestCron = e.WEEKLY_DIGEST_CRON?.trim() || '0 9 * * 1';
  const budgetBreachCheckEnabled = parseBudgetBreachCheckEnabled(
    e.BUDGET_BREACH_CHECK_ENABLED,
    nodeEnv,
  );
  const budgetBreachCheckCron = e.BUDGET_BREACH_CHECK_CRON?.trim() || '0 8 * * *';
  const dividendMatchEnabled = parseDividendMatchEnabled(
    e.DIVIDEND_MATCH_ENABLED,
    nodeEnv,
  );
  const dividendMatchCron = e.DIVIDEND_MATCH_CRON?.trim() || '30 3 * * *';
  const subscriptionPriceDetectEnabled = parseSubscriptionPriceDetectEnabled(
    e.SUBSCRIPTION_PRICE_DETECT_ENABLED,
    nodeEnv,
  );
  const subscriptionPriceDetectCron = e.SUBSCRIPTION_PRICE_DETECT_CRON?.trim() || '0 2 * * *';

  return {
    csvUploadDir,
    changelogDir,
    databaseUrl,
    databasePath,
    port,
    trustProxy,
    defaultCurrency,
    corsOrigin,
    nodeEnv,
    logoDevToken,
    quoteSchedulerEnabled,
    quoteTickCron,
    quoteMinAgeHours,
    dividendReconcileEnabled,
    dividendDedupDays,
    forwardIncomeEnabled,
    forwardIncomeCron,
    dailySnapshotEnabled,
    dailySnapshotCron,
    enrichmentBackfillEnabled,
    enrichmentBackfillCron,
    weeklyDigestEnabled,
    weeklyDigestCron,
    budgetBreachCheckEnabled,
    budgetBreachCheckCron,
    dividendMatchEnabled,
    dividendMatchCron,
    subscriptionPriceDetectEnabled,
    subscriptionPriceDetectCron,
  };
}

export function parseWeeklyDigestEnabled(
  raw: string | undefined,
  nodeEnv: string,
): boolean {
  const trimmed = raw?.trim().toLowerCase();
  if (trimmed && QUOTE_TRUTHY.has(trimmed)) return true;
  if (trimmed && QUOTE_FALSY.has(trimmed)) return false;
  // Default OFF in test so the cron doesn't fire during integration tests.
  // Default ON in dev/prod so a freshly-deployed server starts shipping
  // digests on schedule.
  if (nodeEnv === 'test') return false;
  return true;
}

const QUOTE_TRUTHY = new Set(['true', '1', 'yes']);
const QUOTE_FALSY = new Set(['false', '0', 'no']);

export function parseQuoteSchedulerEnabled(
  raw: string | undefined,
  nodeEnv: string,
): boolean {
  const trimmed = raw?.trim().toLowerCase();
  if (trimmed && QUOTE_TRUTHY.has(trimmed)) return true;
  if (trimmed && QUOTE_FALSY.has(trimmed)) return false;
  if (nodeEnv === 'test') return false;
  return true;
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

export function parseDailySnapshotEnabled(raw: string | undefined, nodeEnv: string): boolean {
  const trimmed = raw?.trim().toLowerCase();
  if (trimmed && QUOTE_TRUTHY.has(trimmed)) return true;
  if (trimmed && QUOTE_FALSY.has(trimmed)) return false;
  if (nodeEnv === 'test') return false;
  return true;
}

export function parseEnrichmentBackfillEnabled(
  raw: string | undefined,
  nodeEnv: string,
): boolean {
  const trimmed = raw?.trim().toLowerCase();
  if (trimmed && QUOTE_TRUTHY.has(trimmed)) return true;
  if (trimmed && QUOTE_FALSY.has(trimmed)) return false;
  if (nodeEnv === 'test') return false;
  return true;
}

/**
 * Default-off in test so the budget breach cron doesn't auto-schedule
 * during the integration-test suite (the dedicated breach-check tests
 * invoke the handler directly). Production / dev defaults on.
 */
export function parseBudgetBreachCheckEnabled(
  raw: string | undefined,
  nodeEnv: string,
): boolean {
  const trimmed = raw?.trim().toLowerCase();
  if (trimmed && QUOTE_TRUTHY.has(trimmed)) return true;
  if (trimmed && QUOTE_FALSY.has(trimmed)) return false;
  if (nodeEnv === 'test') return false;
  return true;
}

/**
 * Daily dividend-reconciliation matcher (#305). Defaults on outside tests so
 * the matcher runs in dev/prod; tests invoke the handler directly.
 */
export function parseDividendMatchEnabled(
  raw: string | undefined,
  nodeEnv: string,
): boolean {
  const trimmed = raw?.trim().toLowerCase();
  if (trimmed && QUOTE_TRUTHY.has(trimmed)) return true;
  if (trimmed && QUOTE_FALSY.has(trimmed)) return false;
  if (nodeEnv === 'test') return false;
  return true;
}

/**
 * Default-off in test so the subscription price-detect cron doesn't
 * auto-schedule during the integration-test suite. Production / dev
 * defaults on.
 */
export function parseSubscriptionPriceDetectEnabled(
  raw: string | undefined,
  nodeEnv: string,
): boolean {
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
export const changelogDir = resolved.changelogDir;
export const databaseUrl = resolved.databaseUrl;
export const databasePath = resolved.databasePath;
export const port = resolved.port;
export const trustProxy = resolved.trustProxy;
export const defaultCurrency = resolved.defaultCurrency;
export const corsOrigin = resolved.corsOrigin;
export const nodeEnv = resolved.nodeEnv;
export const logoDevToken = resolved.logoDevToken;
export const quoteSchedulerEnabled = resolved.quoteSchedulerEnabled;
export const quoteTickCron = resolved.quoteTickCron;
export const quoteMinAgeHours = resolved.quoteMinAgeHours;
export const dividendReconcileEnabled = resolved.dividendReconcileEnabled;
export const dividendDedupDays = resolved.dividendDedupDays;
export const forwardIncomeEnabled = resolved.forwardIncomeEnabled;
export const forwardIncomeCron = resolved.forwardIncomeCron;
export const dailySnapshotEnabled = resolved.dailySnapshotEnabled;
export const dailySnapshotCron = resolved.dailySnapshotCron;
export const enrichmentBackfillEnabled = resolved.enrichmentBackfillEnabled;
export const enrichmentBackfillCron = resolved.enrichmentBackfillCron;
export const weeklyDigestEnabled = resolved.weeklyDigestEnabled;
export const weeklyDigestCron = resolved.weeklyDigestCron;
export const budgetBreachCheckEnabled = resolved.budgetBreachCheckEnabled;
export const budgetBreachCheckCron = resolved.budgetBreachCheckCron;
export const dividendMatchEnabled = resolved.dividendMatchEnabled;
export const dividendMatchCron = resolved.dividendMatchCron;
export const subscriptionPriceDetectEnabled = resolved.subscriptionPriceDetectEnabled;
export const subscriptionPriceDetectCron = resolved.subscriptionPriceDetectCron;

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
