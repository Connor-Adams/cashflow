import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response, NextFunction } from 'express';
import {
  loginRateLimiter,
  registerRateLimiter,
  demoLoginRateLimiter,
  __resetAuthRateLimitForTest,
} from './authRateLimit';

beforeEach(() => {
  __resetAuthRateLimitForTest();
  // Limiters skip in NODE_ENV==='test' (integration-suite determinism); opt
  // back in so this unit test can exercise the real 429 path.
  process.env.AUTH_RATE_LIMIT_FORCE = '1';
  process.env.AUTH_LOGIN_RATE_LIMIT_MAX = '3';
  process.env.AUTH_REGISTER_RATE_LIMIT_MAX = '3';
  process.env.AUTH_DEMO_LOGIN_RATE_LIMIT_MAX = '3';
});

function makeReqRes(opts: { ip?: string; email?: string } = {}) {
  const req = {
    ip: opts.ip ?? '10.0.0.1',
    body: opts.email === undefined ? {} : { email: opts.email },
  } as unknown as Request;
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    headers,
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(_body: unknown) {
      (this as unknown as { body: unknown }).body = _body;
      return this;
    },
  } as unknown as Response;
  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };
  return { req, res, next, wasNext: () => nextCalled };
}

test('loginRateLimiter allows up to N attempts per IP+email window', () => {
  for (let i = 0; i < 3; i++) {
    const { req, res, next, wasNext } = makeReqRes({ email: 'a@b.com' });
    loginRateLimiter(req, res, next);
    assert.equal(wasNext(), true, `attempt ${i + 1} should pass`);
  }
});

test('loginRateLimiter rejects the N+1th attempt with 429', () => {
  for (let i = 0; i < 3; i++) {
    const { req, res, next } = makeReqRes({ email: 'a@b.com' });
    loginRateLimiter(req, res, next);
  }
  const { req, res, next, wasNext } = makeReqRes({ email: 'a@b.com' });
  loginRateLimiter(req, res, next);
  assert.equal(wasNext(), false);
  assert.equal((res as unknown as { statusCode: number }).statusCode, 429);
  assert.equal(
    (res as unknown as { body: { error: string } }).body.error,
    'auth_rate_limit'
  );
});

test('loginRateLimiter keys by IP+email — different email resets', () => {
  for (let i = 0; i < 3; i++) {
    const { req, res, next } = makeReqRes({ email: 'a@b.com' });
    loginRateLimiter(req, res, next);
  }
  const { req, res, next, wasNext } = makeReqRes({ email: 'other@b.com' });
  loginRateLimiter(req, res, next);
  assert.equal(wasNext(), true, 'a different email should not be blocked');
});

test('loginRateLimiter keys by IP+email — different IP resets', () => {
  for (let i = 0; i < 3; i++) {
    const { req, res, next } = makeReqRes({ ip: '10.0.0.1', email: 'a@b.com' });
    loginRateLimiter(req, res, next);
  }
  const { req, res, next, wasNext } = makeReqRes({ ip: '10.0.0.2', email: 'a@b.com' });
  loginRateLimiter(req, res, next);
  assert.equal(wasNext(), true, 'a different IP should not be blocked');
});

test('loginRateLimiter email match is case-insensitive', () => {
  for (let i = 0; i < 3; i++) {
    const { req, res, next } = makeReqRes({ email: 'A@B.com' });
    loginRateLimiter(req, res, next);
  }
  const { req, res, next, wasNext } = makeReqRes({ email: 'a@b.com  ' });
  loginRateLimiter(req, res, next);
  assert.equal(wasNext(), false, 'normalized email should hit the same bucket');
  assert.equal((res as unknown as { statusCode: number }).statusCode, 429);
});

test('registerRateLimiter rejects the N+1th attempt with 429, keyed by IP only', () => {
  // Different emails from the same IP all share the bucket.
  for (let i = 0; i < 3; i++) {
    const { req, res, next } = makeReqRes({ email: `u${i}@b.com` });
    registerRateLimiter(req, res, next);
  }
  const { req, res, next, wasNext } = makeReqRes({ email: 'fresh@b.com' });
  registerRateLimiter(req, res, next);
  assert.equal(wasNext(), false);
  assert.equal((res as unknown as { statusCode: number }).statusCode, 429);
});

test('demoLoginRateLimiter rejects the N+1th attempt with 429, keyed by IP only', () => {
  for (let i = 0; i < 3; i++) {
    const { req, res, next } = makeReqRes();
    demoLoginRateLimiter(req, res, next);
  }
  const { req, res, next, wasNext } = makeReqRes();
  demoLoginRateLimiter(req, res, next);
  assert.equal(wasNext(), false);
  assert.equal((res as unknown as { statusCode: number }).statusCode, 429);
});

test('demoLoginRateLimiter is per-IP — different IP resets', () => {
  for (let i = 0; i < 3; i++) {
    const { req, res, next } = makeReqRes({ ip: '10.0.0.1' });
    demoLoginRateLimiter(req, res, next);
  }
  const { req, res, next, wasNext } = makeReqRes({ ip: '10.0.0.9' });
  demoLoginRateLimiter(req, res, next);
  assert.equal(wasNext(), true);
});

test('the three limiters keep independent buckets for the same IP', () => {
  for (let i = 0; i < 3; i++) {
    const { req, res, next } = makeReqRes({ email: 'a@b.com' });
    loginRateLimiter(req, res, next);
  }
  // login is now exhausted; register from the same IP must still pass.
  const { req, res, next, wasNext } = makeReqRes({ email: 'a@b.com' });
  registerRateLimiter(req, res, next);
  assert.equal(wasNext(), true);
});

test('__resetAuthRateLimitForTest clears all buckets', () => {
  for (let i = 0; i < 4; i++) {
    const { req, res, next } = makeReqRes({ email: 'a@b.com' });
    loginRateLimiter(req, res, next);
  }
  __resetAuthRateLimitForTest();
  const { req, res, next, wasNext } = makeReqRes({ email: 'a@b.com' });
  loginRateLimiter(req, res, next);
  assert.equal(wasNext(), true);
});
