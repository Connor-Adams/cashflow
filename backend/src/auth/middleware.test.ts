import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Response } from 'express';
import { setSessionCookie, clearSessionCookie } from './middleware';

// Capture the Set-Cookie value written by the cookie helpers without a real
// Express response.
function captureSetCookie(fn: (res: Response) => void): string {
  let header = '';
  const res = {
    setHeader(name: string, value: string) {
      if (name === 'Set-Cookie') header = value;
    },
  } as unknown as Response;
  fn(res);
  return header;
}

const origDomain = process.env.SESSION_COOKIE_DOMAIN;
const origNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (origDomain === undefined) delete process.env.SESSION_COOKIE_DOMAIN;
  else process.env.SESSION_COOKIE_DOMAIN = origDomain;
  if (origNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = origNodeEnv;
});

const expires = new Date('2030-01-01T00:00:00Z');

test('setSessionCookie includes Domain when SESSION_COOKIE_DOMAIN is set', () => {
  process.env.SESSION_COOKIE_DOMAIN = '.cashflow.example.com';
  const header = captureSetCookie((res) => setSessionCookie(res, 'tok', expires));
  assert.match(header, /;\s*Domain=\.cashflow\.example\.com(;|$)/);
});

test('setSessionCookie omits Domain when SESSION_COOKIE_DOMAIN is unset', () => {
  delete process.env.SESSION_COOKIE_DOMAIN;
  const header = captureSetCookie((res) => setSessionCookie(res, 'tok', expires));
  assert.doesNotMatch(header, /Domain=/);
});

test('clearSessionCookie includes the same Domain so the cookie can be cleared', () => {
  // A cookie set with Domain= can only be cleared by a matching Domain=.
  process.env.SESSION_COOKIE_DOMAIN = '.cashflow.example.com';
  const header = captureSetCookie((res) => clearSessionCookie(res));
  assert.match(header, /;\s*Domain=\.cashflow\.example\.com(;|$)/);
});

test('production cookie keeps SameSite=None; Secure alongside Domain', () => {
  process.env.NODE_ENV = 'production';
  process.env.SESSION_COOKIE_DOMAIN = '.cashflow.example.com';
  const header = captureSetCookie((res) => setSessionCookie(res, 'tok', expires));
  assert.match(header, /SameSite=None/);
  assert.match(header, /Secure/);
  assert.match(header, /Domain=\.cashflow\.example\.com/);
});

test('production cookie WITHOUT a cookie domain uses SameSite=Lax (not None)', () => {
  // SameSite=None opens the cookie to cross-site delivery — only justified for
  // the cross-subdomain deployment that needs SESSION_COOKIE_DOMAIN. With no
  // domain configured the API is same-host with the UI, so Lax is both safe and
  // sufficient, and it shrinks the CSRF attack surface (issue #825).
  process.env.NODE_ENV = 'production';
  delete process.env.SESSION_COOKIE_DOMAIN;
  const header = captureSetCookie((res) => setSessionCookie(res, 'tok', expires));
  assert.match(header, /SameSite=Lax/);
  assert.doesNotMatch(header, /SameSite=None/);
});

test('expired cookie WITHOUT a cookie domain also uses SameSite=Lax', () => {
  process.env.NODE_ENV = 'production';
  delete process.env.SESSION_COOKIE_DOMAIN;
  const header = captureSetCookie((res) => clearSessionCookie(res));
  assert.match(header, /SameSite=Lax/);
  assert.doesNotMatch(header, /SameSite=None/);
});
