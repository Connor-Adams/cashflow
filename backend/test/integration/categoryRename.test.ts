import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express; let authed: ReturnType<typeof request.agent>; let testDb: PgTestDb;
before(async () => {
  testDb = await setupPgTestDb('category-rename');
  app = (await import('../../src/app.js')).default;
  authed = request.agent(app);
  await authed.post('/api/auth/register').send({ email: 'cr@example.com', displayName: 'C', password: 'password123' });
});
after(async () => { await teardownPgTestDb(testDb); });

test('rename updates the node and is rejected on sibling conflict', async () => {
  const work = await authed.post('/api/categories').send({ name: 'Work', parentId: null });
  const internet = await authed.post('/api/categories').send({ name: 'Internet', parentId: work.body.id });
  await authed.post('/api/categories').send({ name: 'Phone', parentId: work.body.id });

  const ok = await authed.patch(`/api/categories/${internet.body.id}`).send({ name: 'WiFi' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.name, 'WiFi');

  const conflict = await authed.patch(`/api/categories/${internet.body.id}`).send({ name: 'Phone' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'sibling_conflict');
});
