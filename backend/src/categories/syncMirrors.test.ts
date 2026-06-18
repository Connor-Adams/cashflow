// backend/src/categories/syncMirrors.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Category, Household, Account, Transaction, Rule, BudgetTarget } from '../models';
import { syncCategoryLeafNameMirrors } from './syncMirrors';

let householdId: number, accountId: number, catId: number;
beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
  accountId = (await Account.create({ householdId, name: 'A', type: 'chequing', currency: 'CAD' })).id;
  catId = (await Category.create({ householdId, name: 'Internet', icon: null, parentId: null })).id;
});

test('fans the new leaf name out to all string mirrors referencing the id', async () => {
  const t = await Transaction.create({
    householdId, accountId, date: '2026-01-01', amount: -5, currency: 'CAD',
    importBatch: 'test-batch', merchantRaw: 'ISP', merchantClean: 'ISP',
    sourceRowFingerprint: 'fp1', sourceIdentityFingerprint: 'ifp1',
    finalCategoryId: catId,
  } as never);
  const r = await Rule.create({ householdId, merchantPattern: 'ISP', categoryId: catId, category: 'Internet' } as never);
  const b = await BudgetTarget.create({ householdId, categoryId: catId, category: 'Internet', currency: 'CAD', amount: '50' } as never);
  assert.equal(t.finalCategory, 'Internet'); // derived by hook
  await sequelize.transaction(async (tx) => {
    await Category.update({ name: 'WiFi', nameKey: 'wifi' }, { where: { id: catId }, transaction: tx });
    await syncCategoryLeafNameMirrors(catId, 'WiFi', tx);
  });
  await t.reload(); await r.reload(); await b.reload();
  assert.equal(t.finalCategory, 'WiFi');
  assert.equal(r.category, 'WiFi');
  assert.equal(b.category, 'WiFi');
});
