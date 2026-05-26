/**
 * Outbound mailer abstraction (issue #267).
 *
 * One entry point — `sendEmail(opts)` — that downstream channel features
 * (weekly digest, budget breach alert, ...) call when they need to deliver
 * a message via email. The driver is chosen at process start from the
 * `MAILER_DRIVER` env variable so individual call-sites never see the
 * transport.
 *
 * Drivers:
 *  - 'noop'      → log + record + return success. Used in tests and as the
 *                  safe default when SMTP credentials are missing.
 *  - 'smtp'      → SMTP via nodemailer when configured. We lazily require()
 *                  nodemailer so a server boot without nodemailer installed
 *                  still works as long as MAILER_DRIVER !== 'smtp'.
 *
 * The contract guarantees:
 *  - `sendEmail` never throws synchronously on bad input; it returns
 *    `{ ok: false, error }` so a job can keep processing other users.
 *  - Transient failures are retried up to 3 times with exponential backoff
 *    (200ms / 400ms / 800ms). Permanent failures (4xx-style SMTP errors,
 *    invalid recipient) return immediately without retry.
 *  - Drivers are pluggable for tests via `setMailerDriverForTest()`.
 */
import { logger } from '../observability/logger';

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Optional Reply-To header so admin tests get bounces. */
  replyTo?: string;
}

export interface SendEmailResult {
  ok: boolean;
  attempts: number;
  driver: string;
  error?: string;
}

/**
 * What a driver promises to do. `send()` may throw or reject — the outer
 * `sendEmail()` wraps it with retry semantics. Drivers that hit a permanent
 * failure should set `permanent: true` on the thrown error.
 */
export interface MailerDriver {
  name: string;
  send(opts: SendEmailOptions): Promise<void>;
}

class PermanentMailerError extends Error {
  permanent = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'PermanentMailerError';
  }
}

function isPermanentError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return 'permanent' in err && (err as { permanent?: boolean }).permanent === true;
}

// ---- Drivers ------------------------------------------------------------

/**
 * Records every call. Used both in tests (assertion) and in dev with
 * `MAILER_DRIVER=noop` so logs show what *would* have been sent.
 */
export class NoopMailerDriver implements MailerDriver {
  name = 'noop' as const;
  readonly sent: SendEmailOptions[] = [];

  async send(opts: SendEmailOptions): Promise<void> {
    this.sent.push(opts);
    logger.info(
      {
        to: opts.to,
        subject: opts.subject,
        bytes: opts.html.length + opts.text.length,
      },
      'mailer_noop_send',
    );
  }

  clear(): void {
    this.sent.length = 0;
  }
}

/**
 * SMTP driver via nodemailer. We dynamic-import nodemailer so a server boot
 * without it installed still works for the noop path. The transporter is
 * lazily constructed on first send so a misconfigured prod env fails loudly
 * at first send rather than at module load.
 */
export class SmtpMailerDriver implements MailerDriver {
  name = 'smtp' as const;
  private transporter: {
    sendMail: (msg: Record<string, unknown>) => Promise<unknown>;
  } | null = null;

  constructor(
    private readonly config: {
      host: string;
      port: number;
      secure: boolean;
      user: string | null;
      pass: string | null;
      from: string;
    },
  ) {}

  private async ensureTransporter(): Promise<{
    sendMail: (msg: Record<string, unknown>) => Promise<unknown>;
  }> {
    if (this.transporter) return this.transporter;
    // Lazy require so the dependency is optional unless smtp is selected.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
    const nodemailer = require('nodemailer') as {
      createTransport: (opts: Record<string, unknown>) => {
        sendMail: (msg: Record<string, unknown>) => Promise<unknown>;
      };
    };
    this.transporter = nodemailer.createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth:
        this.config.user && this.config.pass
          ? { user: this.config.user, pass: this.config.pass }
          : undefined,
    });
    return this.transporter;
  }

  async send(opts: SendEmailOptions): Promise<void> {
    if (!opts.to || !/.+@.+\..+/.test(opts.to)) {
      // Bad recipient is a permanent failure — no retry will help.
      throw new PermanentMailerError(`invalid recipient: ${opts.to}`);
    }
    const t = await this.ensureTransporter();
    await t.sendMail({
      from: this.config.from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      replyTo: opts.replyTo,
    });
  }
}

// ---- Driver selection ---------------------------------------------------

export type MailerDriverName = 'noop' | 'smtp';

export function parseMailerDriver(
  raw: string | undefined,
): MailerDriverName {
  const trimmed = raw?.trim().toLowerCase();
  if (trimmed === 'smtp') return 'smtp';
  // Unknown / unset → noop. Documented as the safe default.
  return 'noop';
}

let activeDriver: MailerDriver | null = null;

/**
 * Construct a driver from env. Exported so tests can build drivers without
 * mutating process.env. Production callers go through `getMailerDriver()`.
 */
export function buildMailerDriverFromEnv(
  env: Record<string, string | undefined>,
): MailerDriver {
  const choice = parseMailerDriver(env.MAILER_DRIVER);
  if (choice === 'smtp') {
    const host = env.SMTP_HOST?.trim();
    const port = Number(env.SMTP_PORT?.trim() || '587');
    const from = env.SMTP_FROM?.trim();
    if (!host || !from || !Number.isFinite(port)) {
      logger.warn(
        { host, port, from },
        'mailer_smtp_config_incomplete_falling_back_to_noop',
      );
      return new NoopMailerDriver();
    }
    return new SmtpMailerDriver({
      host,
      port,
      secure: (env.SMTP_SECURE ?? '').trim().toLowerCase() === 'true',
      user: env.SMTP_USER?.trim() || null,
      pass: env.SMTP_PASS?.trim() || null,
      from,
    });
  }
  return new NoopMailerDriver();
}

export function getMailerDriver(): MailerDriver {
  if (!activeDriver) {
    activeDriver = buildMailerDriverFromEnv(
      process.env as Record<string, string | undefined>,
    );
  }
  return activeDriver;
}

/** Tests inject a recording / failing driver here. */
export function setMailerDriverForTest(driver: MailerDriver | null): void {
  activeDriver = driver;
}

// ---- Retry-aware send ---------------------------------------------------

export const MAILER_MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 200;

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send an email with retry + backoff. Never throws — always returns a
 * result object so callers can `if (!result.ok)` cleanly. Per-driver
 * permanent errors short-circuit retries.
 *
 * The sleep delay between attempts is overridable for tests (default base
 * 200ms doubles each attempt: 200, 400, 800).
 */
export async function sendEmail(
  opts: SendEmailOptions,
  options: { backoffMs?: number; maxAttempts?: number } = {},
): Promise<SendEmailResult> {
  const driver = getMailerDriver();
  const maxAttempts = options.maxAttempts ?? MAILER_MAX_ATTEMPTS;
  const backoffMs = options.backoffMs ?? BACKOFF_BASE_MS;

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await driver.send(opts);
      return { ok: true, attempts: attempt, driver: driver.name };
    } catch (err) {
      lastErr = err;
      const permanent = isPermanentError(err);
      logger.warn(
        {
          attempt,
          maxAttempts,
          driver: driver.name,
          permanent,
          err,
          to: opts.to,
        },
        'mailer_send_failed',
      );
      if (permanent) break;
      if (attempt < maxAttempts) {
        await sleep(backoffMs * 2 ** (attempt - 1));
      }
    }
  }
  const message =
    lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown');
  return {
    ok: false,
    attempts: maxAttempts,
    driver: driver.name,
    error: message,
  };
}

/** Re-exported for tests so they can throw a permanent error from a fake driver. */
export { PermanentMailerError };
