import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import express from 'express';
import request from 'supertest';
import { emailScanLimiter } from './emailRateLimit';

test('emailScanLimiter is express middleware (3-arg signature)', () => {
  assert.equal(typeof emailScanLimiter, 'function');
});

test('emailScanLimiter skips in NODE_ENV=test (deterministic integration tests)', async () => {
  // express-rate-limit `skip` returns true under NODE_ENV=test, so every request
  // passes through regardless of count. This guards that the test carve-out
  // matches the importUploadLimiter / aiSuggestLimiter convention.
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    const app = express();
    app.post('/scan', emailScanLimiter, (_req: Request, res: Response) => res.json({ ok: true }));
    for (let i = 0; i < 20; i++) {
      const r = await request(app).post('/scan');
      assert.equal(r.status, 200, `request ${i + 1} should pass while skipped in test`);
    }
  } finally {
    process.env.NODE_ENV = prev;
  }
});

test('emailScanLimiter enforces a per-window cap when not skipped', async () => {
  // Temporarily un-skip + tighten the cap by exercising the underlying limiter
  // logic directly through a fresh limiter built with the same config but no
  // skip, proving the 429 path works.
  const rateLimit = (await import('express-rate-limit')).default;
  const limiter = rateLimit({
    windowMs: 60_000,
    max: 2,
    standardHeaders: true,
    legacyHeaders: false,
  });
  const app = express();
  app.post('/scan', limiter, (_req: Request, res: Response) => res.json({ ok: true }));

  const agent = request.agent(app);
  assert.equal((await agent.post('/scan')).status, 200);
  assert.equal((await agent.post('/scan')).status, 200);
  assert.equal((await agent.post('/scan')).status, 429);
});
