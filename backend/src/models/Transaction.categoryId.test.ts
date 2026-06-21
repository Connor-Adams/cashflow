// backend/src/models/Transaction.categoryId.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Transaction, Household, Category, Account } from '../models';

let householdId: number;
let accountId: number;
beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
  accountId = (await Account.create({ householdId, name: 'A' })).id;
});

test('beforeSave sets finalCategoryId from finalCategory string', async () => {
  const t = await Transaction.create({
    householdId,
    accountId,
    date: '2026-01-01',
    amount: -10,
    currency: 'CAD',
    importBatch: 'test-batch',
    merchantRaw: 'x',
    merchantClean: 'x',
    sourceRowFingerprint: 'fp1',
    sourceIdentityFingerprint: 'ifp1',
    reviewFlag: false,
    finalCategory: 'Groceries',
  });
  assert.ok(t.finalCategoryId);
  const node = await Category.findByPk(t.finalCategoryId!);
  assert.equal(node?.name, 'Groceries');
  assert.equal(node?.parentId, null);
});

test('sets autoCategoryId + categoryOverrideId independently', async () => {
  const t = await Transaction.create({
    householdId,
    accountId,
    date: '2026-01-01',
    amount: -5,
    currency: 'CAD',
    importBatch: 'test-batch',
    merchantRaw: 'y',
    merchantClean: 'y',
    sourceRowFingerprint: 'fp2',
    sourceIdentityFingerprint: 'ifp2',
    reviewFlag: false,
    autoCategory: 'Dining',
    categoryOverride: 'Travel',
    finalCategory: 'Travel',
  });
  const auto = await Category.findByPk(t.autoCategoryId!);
  const over = await Category.findByPk(t.categoryOverrideId!);
  assert.equal(auto?.name, 'Dining');
  assert.equal(over?.name, 'Travel');
  assert.equal(t.finalCategoryId, t.categoryOverrideId);
});

test('null finalCategory leaves finalCategoryId null', async () => {
  const t = await Transaction.create({
    householdId,
    accountId,
    date: '2026-01-01',
    amount: -5,
    currency: 'CAD',
    importBatch: 'test-batch',
    merchantRaw: 'z',
    merchantClean: 'z',
    sourceRowFingerprint: 'fp3',
    sourceIdentityFingerprint: 'ifp3',
    reviewFlag: false,
    finalCategory: null,
  });
  assert.equal(t.finalCategoryId, null);
});
