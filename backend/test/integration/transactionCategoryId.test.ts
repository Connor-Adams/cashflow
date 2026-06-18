/**
 * Integration tests: PATCH /api/transactions/:id accepts `categoryOverrideId`
 * to tag a transaction to a child category node.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let householdId: number;
let accountId: number;
let models: typeof import('../../src/models/index.js');
let testDb: PgTestDb;

before(async () => {
  testDb = await setupPgTestDb('txn-categoryid');
  models = await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;
  authed = request.agent(app);
  const reg = await authed
    .post('/api/auth/register')
    .send({ email: 'tc@example.com', displayName: 'T', password: 'password123' });
  assert.equal(reg.status, 201);
  householdId = (reg.body.user.household?.id ?? reg.body.user.householdId) as number;

  // Create an account via the model layer (consistent with other integration tests).
  const account = await models.Account.create({
    householdId,
    name: 'TC Visa',
    owner: 'me',
    defaultCurrency: 'CAD',
  } as never);
  accountId = account.id;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

/** Helper: create a minimal transaction row via the model layer. */
async function seedTransaction(): Promise<number> {
  const txn = await models.Transaction.create({
    accountId,
    householdId,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'cat-id-test',
    date: '2026-06-01',
    merchantRaw: 'TELUS',
    merchantClean: 'TELUS',
    amount: '-80.00',
    currency: 'CAD',
    finalBusiness: false,
    finalSplitType: 'me',
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
  } as never);
  return txn.id;
}

test('PATCH categoryOverrideId tags the txn to a child node and finalCategoryId follows', async () => {
  const work = await authed.post('/api/categories').send({ name: 'Work', parentId: null });
  assert.equal(work.status, 201, `POST /api/categories Work: ${JSON.stringify(work.body)}`);
  const internet = await authed
    .post('/api/categories')
    .send({ name: 'Internet', parentId: work.body.id });
  assert.equal(internet.status, 201, `POST /api/categories Internet: ${JSON.stringify(internet.body)}`);

  const txnId = await seedTransaction();

  const res = await authed
    .patch(`/api/transactions/${txnId}`)
    .send({ categoryOverrideId: internet.body.id });
  assert.equal(res.status, 200, `PATCH failed: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.categoryOverrideId, internet.body.id);
  assert.equal(res.body.finalCategoryId, internet.body.id);
  assert.equal(res.body.finalCategory, 'Internet');
});

test('PATCH categoryOverrideId null clears the override and falls back finalCategoryId to autoCategoryId', async () => {
  // Seed a transaction with an auto category set at the model layer.
  const autocat = await authed.post('/api/categories').send({ name: 'Food', parentId: null });
  assert.equal(autocat.status, 201);
  const autoCatId = autocat.body.id as number;

  const txnWithAuto = await models.Transaction.create({
    accountId,
    householdId,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'cat-id-auto-test',
    date: '2026-06-01',
    merchantRaw: 'GROCERY',
    merchantClean: 'GROCERY',
    amount: '-30.00',
    currency: 'CAD',
    finalBusiness: false,
    finalSplitType: 'me',
    autoCategory: 'Food',
    autoCategoryId: autoCatId,
    finalCategory: 'Food',
    finalCategoryId: autoCatId,
    sourceRowFingerprint: require('crypto').randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: require('crypto').randomBytes(16).toString('hex'),
  } as never);
  const txnId = txnWithAuto.id;

  // Set an override.
  const overrideCat = await authed.post('/api/categories').send({ name: 'Utilities', parentId: null });
  assert.equal(overrideCat.status, 201);
  const set = await authed
    .patch(`/api/transactions/${txnId}`)
    .send({ categoryOverrideId: overrideCat.body.id });
  assert.equal(set.status, 200);
  assert.equal(set.body.categoryOverrideId, overrideCat.body.id);
  assert.equal(set.body.finalCategoryId, overrideCat.body.id);

  // Clear the override — finalCategoryId must fall back to autoCategoryId, NOT null.
  const clear = await authed
    .patch(`/api/transactions/${txnId}`)
    .send({ categoryOverrideId: null });
  assert.equal(clear.status, 200, `clear failed: ${JSON.stringify(clear.body)}`);
  assert.equal(clear.body.categoryOverrideId, null, 'categoryOverrideId should be null after clear');
  assert.equal(
    clear.body.finalCategoryId,
    autoCatId,
    'finalCategoryId must fall back to autoCategoryId after clearing override',
  );
  assert.equal(clear.body.finalCategory, 'Food', 'finalCategory must reflect autoCategoryId after clear');
});

test('PATCH categoryOverrideId rejects an id from another household with 400', async () => {
  const { Household, User: UserModel, HouseholdMember, Session: SessionModel, Category: CategoryModel } = models;
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const pwd = await hashPassword('password123');
  const otherUser = await UserModel.create({
    email: 'tc-other@example.com',
    displayName: 'Other',
    globalRole: 'user',
    passwordHash: pwd.hash,
    passwordSalt: pwd.salt,
    passwordParams: pwd.params,
  });
  const otherHousehold = await Household.create({ name: 'Other Household TC' });
  const otherHouseholdId = otherHousehold.id;
  await HouseholdMember.create({ householdId: otherHouseholdId, userId: otherUser.id, role: 'owner' });
  const rawToken = crypto.randomBytes(32).toString('hex');
  await SessionModel.create({
    userId: otherUser.id,
    tokenHash: hashToken(rawToken),
    expiresAt: new Date(Date.now() + 86400 * 1000),
  });

  // Create a category in the OTHER household.
  const otherCat = await CategoryModel.create({
    householdId: otherHouseholdId,
    name: 'Foreign Cat',
    parentId: null,
    taxTreatment: 'personal',
  } as never);

  // Seed a transaction in the MAIN household.
  const txnId = await seedTransaction();

  // Try to PATCH with the other household's category id → should be 400.
  const res = await authed
    .patch(`/api/transactions/${txnId}`)
    .send({ categoryOverrideId: otherCat.id });
  assert.equal(res.status, 400, `Expected 400 but got ${res.status}: ${JSON.stringify(res.body)}`);
});
