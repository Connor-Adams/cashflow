import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let testDb: PgTestDb;

before(async () => {
  testDb = await setupPgTestDb('categories-tree');
  const mod = await import('../../src/app.js');
  app = mod.default;
  authed = testAgent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'cats@example.com',
    displayName: 'Cat User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
});

after(async () => { await teardownPgTestDb(testDb); });

test('resolve-path creates a chain and tree reflects it', async () => {
  const resolved = await authed.post('/api/categories/resolve-path').send({ path: 'Work / Expenses / Internet' });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.name, 'Internet');
  assert.equal(resolved.body.createdIds.length, 3);

  const tree = await authed.get('/api/categories/tree');
  assert.equal(tree.status, 200);
  const work = tree.body.find((n: { name: string }) => n.name === 'Work');
  assert.ok(work, 'Work root present');
  assert.equal(work.children[0].name, 'Expenses');
  assert.equal(work.children[0].children[0].name, 'Internet');
});

test('reparent moves a node; cycle is rejected', async () => {
  const home = await authed.post('/api/categories').send({ name: 'Home', parentId: null });
  assert.equal(home.status, 201);
  const tree = await authed.get('/api/categories/tree');
  const work = tree.body.find((n: { name: string }) => n.name === 'Work');
  const expenses = work.children[0];

  const moved = await authed.patch(`/api/categories/${expenses.id}/reparent`).send({ parentId: home.body.id });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.parentId, home.body.id);

  const cycle = await authed.patch(`/api/categories/${home.body.id}/reparent`).send({ parentId: expenses.id });
  assert.equal(cycle.status, 409);
  assert.equal(cycle.body.code, 'cycle');
});

test('delete blocks a node with children, allows a leaf', async () => {
  const tree = await authed.get('/api/categories/tree');
  const home = tree.body.find((n: { name: string }) => n.name === 'Home');
  const blocked = await authed.delete(`/api/categories/${home.id}`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'has_children');

  const leaf = await authed.post('/api/categories').send({ name: 'Snacks', parentId: null });
  const ok = await authed.delete(`/api/categories/${leaf.body.id}`);
  assert.equal(ok.status, 204);
});
