import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express; let authed: ReturnType<typeof request.agent>; let testDb: PgTestDb;
before(async () => {
  testDb = await setupPgTestDb('category-rename');
  app = (await import('../../src/app.js')).default;
  authed = testAgent(app);
  await authed.post('/api/auth/register').send({ email: 'cr@example.com', displayName: 'C', password: 'password123' });
});
after(async () => { await teardownPgTestDb(testDb); });

test('rename updates the node and is rejected on a household-wide name conflict', async () => {
  const work = await authed.post('/api/categories').send({ name: 'Work', parentId: null });
  const family = await authed.post('/api/categories').send({ name: 'Family', parentId: null });
  const internet = await authed.post('/api/categories').send({ name: 'Internet', parentId: work.body.id });
  await authed.post('/api/categories').send({ name: 'Phone', parentId: work.body.id });
  await authed.post('/api/categories').send({ name: 'Mobile', parentId: family.body.id });

  const ok = await authed.patch(`/api/categories/${internet.body.id}`).send({ name: 'WiFi' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.name, 'WiFi');

  // Sibling conflict: "Phone" is a child of the same parent ("work") as the
  // renamed node. Both the old parent-scoped check and the new
  // household-wide check reject this identically — it pins the 409 and the
  // name_conflict error code for the ordinary case, but does not on its own
  // prove the scope was widened.
  const siblingConflict = await authed.patch(`/api/categories/${internet.body.id}`).send({ name: 'Phone' });
  assert.equal(siblingConflict.status, 409);
  assert.equal(siblingConflict.body.code, 'name_conflict');

  // Household-wide conflict: "Mobile" lives under "family", a different
  // branch of the tree with a different parentId than the renamed node's
  // ("work"). The OLD parent-scoped check
  // (`where: { parentId: row.parentId, ... }`) would find no conflict here —
  // "Mobile" has no sibling under "work" — and would let the rename through.
  // Only the household-wide check (no parentId in the where clause) rejects
  // it. This is the case Task 5 actually widened; the sibling case above
  // would pass unchanged under either scope.
  const crossBranchConflict = await authed.patch(`/api/categories/${internet.body.id}`).send({ name: 'Mobile' });
  assert.equal(crossBranchConflict.status, 409);
  assert.equal(crossBranchConflict.body.code, 'name_conflict');
});
