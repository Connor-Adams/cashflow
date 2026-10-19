/**
 * GET /api/config must only advertise web-push when the server can actually
 * send it. A public VAPID key alone (no private key) means `isPushConfigured()`
 * is false and every fan-out is a no-op — so the client must see
 * `vapidPublicKey: null` and render push as unavailable.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

process.env.VAPID_PUBLIC_KEY = 'public-only-key';
delete process.env.VAPID_PRIVATE_KEY;

let app: express.Express;

before(async () => {
  const { default: configRouter } = await import('./config');
  app = express();
  app.use('/api/config', configRouter);
});

test('half-configured VAPID (public key only) reports push unavailable', async () => {
  const res = await request(app).get('/api/config');
  assert.equal(res.status, 200);
  assert.equal(res.body.vapidPublicKey, null);
  assert.equal(res.body.vapidPrivateKey, undefined, 'never expose the private key');
});
