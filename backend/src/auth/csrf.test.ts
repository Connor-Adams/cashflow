import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { csrfGuard, isOriginAllowed } from './csrf';
import { SESSION_COOKIE } from './middleware';

const origCors = process.env.CORS_ORIGIN;
const origNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (origCors === undefined) delete process.env.CORS_ORIGIN;
  else process.env.CORS_ORIGIN = origCors;
  if (origNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = origNodeEnv;
});

const ALLOWED = 'https://cashflow.example.com';

function makeReq(opts: {
  method: string;
  path?: string;
  origin?: string;
  referer?: string;
  cookie?: string;
}): Request {
  const headers: Record<string, string> = {};
  if (opts.origin !== undefined) headers.origin = opts.origin;
  if (opts.referer !== undefined) headers.referer = opts.referer;
  if (opts.cookie !== undefined) headers.cookie = opts.cookie;
  return {
    method: opts.method,
    path: opts.path ?? '/api/transactions',
    headers,
  } as unknown as Request;
}

function run(req: Request): { status?: number; body?: unknown; nexted: boolean } {
  const result: { status?: number; body?: unknown; nexted: boolean } = { nexted: false };
  const res = {
    status(code: number) {
      result.status = code;
      return this;
    },
    json(payload: unknown) {
      result.body = payload;
      return this;
    },
  } as unknown as Response;
  csrfGuard(req, res, () => {
    result.nexted = true;
  });
  return result;
}

const sessionCookie = `${SESSION_COOKIE}=abc123`;

test('isOriginAllowed accepts the configured frontend origin', () => {
  assert.equal(isOriginAllowed(ALLOWED, ALLOWED), true);
});

test('isOriginAllowed rejects an unrelated origin', () => {
  assert.equal(isOriginAllowed('https://evil.example.org', ALLOWED), false);
});

test('GET requests pass without an Origin check', () => {
  const r = run(makeReq({ method: 'GET', cookie: sessionCookie }));
  assert.equal(r.nexted, true);
});

test('OPTIONS preflight passes without an Origin check', () => {
  const r = run(makeReq({ method: 'OPTIONS', cookie: sessionCookie }));
  assert.equal(r.nexted, true);
});

test('cookie-authed POST from the allowed origin passes', () => {
  process.env.CORS_ORIGIN = ALLOWED;
  const r = run(makeReq({ method: 'POST', origin: ALLOWED, cookie: sessionCookie }));
  assert.equal(r.nexted, true);
});

test('cookie-authed POST from a foreign origin is rejected with 403', () => {
  process.env.CORS_ORIGIN = ALLOWED;
  const r = run(
    makeReq({ method: 'POST', origin: 'https://evil.example.org', cookie: sessionCookie }),
  );
  assert.equal(r.nexted, false);
  assert.equal(r.status, 403);
});

test('a foreign origin is rejected even outside production', () => {
  // The positive allow-list always applies: a present-but-foreign Origin is
  // blocked regardless of environment.
  delete process.env.NODE_ENV;
  process.env.CORS_ORIGIN = ALLOWED;
  const r = run(
    makeReq({ method: 'POST', origin: 'https://evil.example.org', cookie: sessionCookie }),
  );
  assert.equal(r.nexted, false);
  assert.equal(r.status, 403);
});

test('a cookie-authed POST with NO Origin or Referer passes (SameSite backstop)', () => {
  // A browser ALWAYS attaches Origin to a cross-origin mutating fetch, so a
  // forgery always carries one and is caught by the allow-list. Absence of any
  // origin signal means a non-browser/same-origin caller (curl, native app,
  // supertest harness), which is not a CSRF vector; SameSite=Lax on the cookie
  // is the backstop. We allow it rather than break legitimate callers.
  process.env.NODE_ENV = 'production';
  process.env.CORS_ORIGIN = ALLOWED;
  const r = run(makeReq({ method: 'POST', cookie: sessionCookie }));
  assert.equal(r.nexted, true);
});

test('a foreign Origin is rejected in production too', () => {
  process.env.NODE_ENV = 'production';
  process.env.CORS_ORIGIN = ALLOWED;
  const r = run(
    makeReq({ method: 'POST', origin: 'https://evil.example.org', cookie: sessionCookie }),
  );
  assert.equal(r.nexted, false);
  assert.equal(r.status, 403);
});

test('cookie-authed DELETE from a foreign origin is rejected', () => {
  process.env.CORS_ORIGIN = ALLOWED;
  const r = run(
    makeReq({
      method: 'DELETE',
      path: '/api/household/members/42',
      origin: 'https://evil.example.org',
      cookie: sessionCookie,
    }),
  );
  assert.equal(r.nexted, false);
  assert.equal(r.status, 403);
});

test('POST WITHOUT the session cookie is exempt (token-authed flows)', () => {
  // Bookmarklet capture / reporting / audit use Bearer tokens and credentials:
  // false, so they never carry the session cookie and are not a CSRF target.
  process.env.CORS_ORIGIN = ALLOWED;
  const r = run(
    makeReq({
      method: 'POST',
      path: '/api/capture/orders',
      origin: 'https://amazon.ca',
    }),
  );
  assert.equal(r.nexted, true);
});

test('Referer is used as the origin fallback when Origin is absent', () => {
  process.env.CORS_ORIGIN = ALLOWED;
  const r = run(
    makeReq({
      method: 'POST',
      referer: `${ALLOWED}/transactions/new`,
      cookie: sessionCookie,
    }),
  );
  assert.equal(r.nexted, true);
});

test('a foreign Referer is rejected', () => {
  process.env.CORS_ORIGIN = ALLOWED;
  const r = run(
    makeReq({
      method: 'POST',
      referer: 'https://evil.example.org/attack',
      cookie: sessionCookie,
    }),
  );
  assert.equal(r.nexted, false);
  assert.equal(r.status, 403);
});
