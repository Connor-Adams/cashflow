import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import helmet from 'helmet';
import request from 'supertest';
import { noStore } from './noStore';

/**
 * Unit coverage for the global response-header hardening (issue #853). These run
 * without Postgres: we replicate the exact app.ts middleware shape (helmet +
 * the /api-scoped noStore) on a throwaway app and assert the three headers. The
 * integration tests (vault/businessTax) prove the same headers on real authed
 * exports/downloads against the full router stack.
 */

function buildApp() {
  const app = express();
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'none'"],
          'frame-ancestors': ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      frameguard: { action: 'deny' },
    }),
  );
  app.use('/api', noStore);
  app.get('/api/thing', (_req, res) => res.json({ ok: true }));
  // A streaming-style handler that sets its own Cache-Control after noStore runs.
  app.get('/api/stream', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.json({ ok: true });
  });
  // Non-/api route: noStore must NOT apply.
  app.get('/', (_req, res) => res.json({ ok: true }));
  return app;
}

test('noStore sets Cache-Control: no-store on /api responses', async () => {
  const res = await request(buildApp()).get('/api/thing');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('streaming handlers may upgrade to no-store, no-transform (their value wins)', async () => {
  const res = await request(buildApp()).get('/api/stream');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store, no-transform');
});

test('noStore does not apply outside /api', async () => {
  const res = await request(buildApp()).get('/');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], undefined);
});

test('helmet emits clickjacking + referrer + nosniff + CSP frame-ancestors', async () => {
  const res = await request(buildApp()).get('/api/thing');
  // Clickjacking: tightened to DENY (#853) plus the CSP authority.
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.match(
    String(res.headers['content-security-policy']),
    /frame-ancestors 'none'/,
  );
  // Referrer-Policy: no-referrer (helmet default) satisfies the AC.
  assert.match(
    String(res.headers['referrer-policy']),
    /^(no-referrer|strict-origin-when-cross-origin)$/,
  );
  // nosniff retained from #819.
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});
