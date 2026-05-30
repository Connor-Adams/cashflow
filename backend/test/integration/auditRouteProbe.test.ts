import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let server: http.Server;
let port: number;
let authed: ReturnType<typeof request.agent>;
let testDb: PgTestDb;
let auditToken: string;

before(async () => {
  testDb = await setupPgTestDb('audit-route-probe');
  await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;

  // Start a real HTTP server so the route probe can make in-process HTTP calls
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;

  authed = request(server);
  const authedAgent = request.agent(server);
  const reg = await authedAgent.post('/api/auth/register').send({
    email: 'audit-rp@example.com',
    displayName: 'Route Probe',
    password: 'password123',
  });
  assert.equal(reg.status, 201);
  const mint = await authedAgent.post('/api/audit/tokens').send({ label: 'RP' });
  assert.equal(mint.status, 201);
  auditToken = mint.body.plaintext;
  void port; // used by server
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  await teardownPgTestDb(testDb);
});

test('GET /api/audit/route-probe returns expected top-level shape', async () => {
  const res = await request(server)
    .get('/api/audit/route-probe')
    .set('Authorization', `Bearer ${auditToken}`);
  assert.equal(res.status, 200);
  const body = res.body;
  assert.ok(typeof body.generatedAt === 'string');
  assert.ok(Array.isArray(body.routes));
  assert.ok(body.routes.length >= 5, `routes.length ${body.routes.length} should be >= 5`);
});

test('each route has page, apis[], and ok boolean', async () => {
  const res = await request(server)
    .get('/api/audit/route-probe')
    .set('Authorization', `Bearer ${auditToken}`);
  assert.equal(res.status, 200);
  for (const route of res.body.routes) {
    assert.ok(typeof route.page === 'string');
    assert.ok(Array.isArray(route.apis));
    assert.ok(route.apis.length >= 1, `route ${route.page} must have at least one api`);
    assert.ok(typeof route.ok === 'boolean');
    for (const api of route.apis) {
      assert.ok('path' in api);
      assert.ok(typeof api.status === 'number');
      assert.ok(typeof api.ok === 'boolean');
    }
  }
});

test('ephemeral session is cleaned up after probe', async () => {
  const { Session } = await import('../../src/models/index.js');
  const countBefore = await Session.count();
  await request(server)
    .get('/api/audit/route-probe')
    .set('Authorization', `Bearer ${auditToken}`);
  // Allow a brief moment for cleanup
  await new Promise((r) => setTimeout(r, 50));
  const countAfter = await Session.count();
  assert.equal(countBefore, countAfter, 'ephemeral session must be cleaned up');
});
