/**
 * Integration tests for the categoryTree rollup on /api/summary/monthly.
 * Verifies that after B2 Task 8, the monthly response carries a categoryTree
 * field whose parent nodes have rolledTotal >= child leaf totals.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let testDb: PgTestDb;

before(async () => {
  testDb = await setupPgTestDb('category-rollup');
  app = (await import('../../src/app.js')).default;
  authed = testAgent(app);

  const register = await authed
    .post('/api/auth/register')
    .send({ email: 'roll@example.com', displayName: 'Rollup User', password: 'password123' });
  assert.equal(register.status, 201);

  // Create Work > Internet category hierarchy via the real endpoint.
  const workRes = await authed.post('/api/categories').send({ name: 'Work', parentId: null });
  assert.equal(workRes.status, 201, `Work create: ${JSON.stringify(workRes.body)}`);
  const workId: number = workRes.body.id;

  const internetRes = await authed
    .post('/api/categories')
    .send({ name: 'Internet', parentId: workId });
  assert.equal(internetRes.status, 201, `Internet create: ${JSON.stringify(internetRes.body)}`);
  const internetId: number = internetRes.body.id;

  // Create an account.
  const accRes = await authed
    .post('/api/accounts')
    .send({ name: 'Checking', owner: 'me', defaultCurrency: 'CAD' });
  assert.equal(accRes.status, 201, `Account create: ${JSON.stringify(accRes.body)}`);

  // Seed the account + transaction via the model layer so we can attach
  // finalCategoryId directly (the API PATCH would also work but requires
  // an extra round-trip). The beforeSave hook in Transaction sets
  // finalCategoryId from finalCategory string matching; since we have the id
  // already we set both fields directly to be safe.
  const models = await import('../../src/models/index.js');
  const account = await models.Account.findOne({ where: { name: 'Checking' } });
  assert.ok(account, 'account exists');
  const household = await models.Household.findOne();
  assert.ok(household, 'household exists');

  // Create the transaction without finalCategory so the beforeSave hook does
  // not call resolveCategoryIdByName (which only resolves ROOT categories by
  // name and would create a new root "Internet" — bypassing our hierarchy).
  // Instead, set finalCategoryId directly after creation using a raw update
  // that skips hooks, so the child category FK is correctly stored.
  const txn = await models.Transaction.create({
    accountId: account.id,
    householdId: household.id,
    importBatch: 'rollup-test',
    date: '2026-06-01',
    merchantRaw: 'INTERNET CO',
    merchantClean: 'Internet Co',
    amount: '-50.00',
    currency: 'CAD',
    status: 'posted',
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    visibility: 'shared',
    ownershipType: 'me',
    finalBusiness: false,
    finalSplitType: 'me',
    myShareAmount: '-50.00',
    partnerShareAmount: '0',
    businessAmount: '0',
    txnType: 'purchase',
    isRecurring: false,
    reviewFlag: false,
  } as never);

  // Bypass hooks to set finalCategoryId to the child category (Internet under
  // Work). The beforeSave hook resolves only root-level categories by name, so
  // we must set the child FK directly to test the rollup hierarchy.
  await models.Transaction.update(
    { finalCategoryId: internetId } as never,
    { where: { id: txn.id }, hooks: false },
  );
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('monthly response includes a categoryTree with parent rollup', async () => {
  const res = await authed.get('/api/summary/monthly?currency=CAD');
  assert.equal(res.status, 200);

  // categoryTree must be present and an array.
  assert.ok(Array.isArray(res.body.categoryTree), 'categoryTree is present and is an array');

  // There must be at least two rows: Work (parent) and Internet (leaf).
  assert.ok(res.body.categoryTree.length >= 2, 'categoryTree has at least 2 rows');

  // Find the Work and Internet nodes.
  type RollupRow = {
    categoryId: number;
    name: string;
    path: string;
    parentId: number | null;
    depth: number;
    directTotal: number;
    rolledTotal: number;
  };
  const tree: RollupRow[] = res.body.categoryTree;
  const workNode = tree.find((r) => r.name === 'Work');
  const internetNode = tree.find((r) => r.name === 'Internet');

  assert.ok(workNode, 'Work node is in categoryTree');
  assert.ok(internetNode, 'Internet node is in categoryTree');

  // Internet is the direct spend node (depth 1, directTotal > 0).
  assert.ok(internetNode.directTotal > 0, 'Internet node has a directTotal');

  // Work's rolledTotal must be >= Internet's directTotal (it is the parent).
  assert.ok(
    workNode.rolledTotal >= internetNode.directTotal,
    `Work rolledTotal (${workNode.rolledTotal}) should be >= Internet directTotal (${internetNode.directTotal})`,
  );
});
