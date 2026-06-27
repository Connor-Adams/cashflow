import type { Request, Response, NextFunction } from 'express';

/**
 * Rate limiters for the unauthenticated /api/auth surface (login, register,
 * demo-login). Each of these handlers runs scrypt (N=16384, CPU-expensive by
 * design) and/or multi-table DB writes with no session, so an unlimited client
 * can brute-force credentials AND amplify CPU/DB load simultaneously. This is
 * the only unprotected mutation surface on the API (issue #833).
 *
 * Uses a simple in-memory sliding-window bucket — same shape as
 * `chatRateLimit.ts`'s perThreadMessageLimiter. In-memory is fine for the
 * single-process backend; if/when we scale horizontally this must move to a
 * shared store (Redis, etc.). Unlike the express-rate-limit limiters
 * (apiReadLimiter, importUploadLimiter, …) these do NOT skip in test: the
 * 429-past-threshold behaviour is the security guarantee and is unit-tested
 * directly. Like every other express-rate-limit limiter in the codebase
 * (apiReadLimiter, importUploadLimiter, …) these SKIP in NODE_ENV==='test' so
 * the integration suite — which fires many register/login requests per process
 * from the same loopback IP against module-global buckets — stays
 * deterministic. The unit test (`authRateLimit.test.ts`) opts back in with
 * `AUTH_RATE_LIMIT_FORCE=1` to verify the real 429 path.
 *
 * Login is keyed by IP + normalized email (so one attacker can't lock out an
 * unrelated victim by guessing their email, and a victim's legitimate retries
 * from a fresh IP aren't blocked). Register and demo-login are keyed by IP
 * (no stable per-account identity to key on pre-account-creation).
 */

interface Bucket {
  windowStart: number;
  count: number;
}

const WINDOW_MS = 60 * 1000;

function shouldSkip(): boolean {
  return process.env.NODE_ENV === 'test' && process.env.AUTH_RATE_LIMIT_FORCE !== '1';
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clientIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function normalizeEmail(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase();
}

/**
 * Build a sliding-window limiter middleware backed by an in-memory bucket map.
 * `keyFor` derives the bucket key from the request; `maxFor` reads the current
 * limit (re-read per request so tests can adjust env freely).
 */
function makeLimiter(
  keyFor: (req: Request) => string,
  maxFor: () => number
): { middleware: (req: Request, res: Response, next: NextFunction) => void; reset: () => void } {
  const buckets = new Map<string, Bucket>();

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    if (shouldSkip()) {
      next();
      return;
    }
    const key = keyFor(req);
    const max = maxFor();
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStart > WINDOW_MS) {
      buckets.set(key, { windowStart: now, count: 1 });
      next();
      return;
    }
    bucket.count++;
    if (bucket.count > max) {
      res.setHeader(
        'Retry-After',
        String(Math.ceil((WINDOW_MS - (now - bucket.windowStart)) / 1000))
      );
      res.status(429).json({
        error: 'auth_rate_limit',
        max,
        window: 'minute',
      });
      return;
    }
    next();
  };

  return { middleware, reset: () => buckets.clear() };
}

const login = makeLimiter(
  (req) => `${clientIp(req)}|${normalizeEmail((req.body as { email?: unknown } | undefined)?.email)}`,
  () => numEnv('AUTH_LOGIN_RATE_LIMIT_MAX', 10)
);

const register = makeLimiter(
  (req) => clientIp(req),
  () => numEnv('AUTH_REGISTER_RATE_LIMIT_MAX', 5)
);

const demoLogin = makeLimiter(
  (req) => clientIp(req),
  () => numEnv('AUTH_DEMO_LOGIN_RATE_LIMIT_MAX', 5)
);

/** Login: 10/min per IP+email by default. Brute-force + scrypt-amplification guard. */
export const loginRateLimiter = login.middleware;
/** Register: 5/min per IP. Mass-account-creation + scrypt-amplification guard. */
export const registerRateLimiter = register.middleware;
/** Demo-login: 5/min per IP. Unauthenticated scrypt + DB amplification guard. */
export const demoLoginRateLimiter = demoLogin.middleware;

/** Test-only: clear all auth rate-limit buckets. */
export function __resetAuthRateLimitForTest(): void {
  login.reset();
  register.reset();
  demoLogin.reset();
}
