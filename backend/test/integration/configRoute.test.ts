/**
 * Integration test for GET /api/config. Verifies that the publishable
 * client config is returned without leaking server secrets.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let testDb: PgTestDb;

before(async () => {
  process.env.LOGO_DEV_TOKEN = 'pk_test_logo';

  testDb = await setupPgTestDb('config-route');

  const mod = await import('../../src/app.js');
  app = mod.default;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('returns publishable config without leaking secrets', async () => {
  const res = await request(app).get('/api/config');
  assert.equal(res.status, 200);
  assert.equal(res.body.logoDevToken, 'pk_test_logo');
  assert.equal(res.body.quoteProviderConfigured, true);
  assert.equal(res.body.alphaVantageApiKey, undefined, 'must not surface AV key field');
});
