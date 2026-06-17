// backend/src/categories/deleteCategory.references.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Category, Household, Account, Transaction, Rule, BudgetTarget } from '../models';
import { deleteCategory } from './deleteCategory';
import { CategoryError } from './errors';

let householdId: number;
let accountId: number;
beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
  accountId = (await Account.create({ householdId, name: 'A', type: 'chequing', currency: 'CAD' })).id;
});

test('blocks delete when a transaction references the category id', async () => {
  await Transaction.create({
    householdId, accountId, date: '2026-01-01', amount: -3, currency: 'CAD',
    importBatch: 'test-batch', merchantRaw: 'Shop', merchantClean: 'Shop',
    sourceRowFingerprint: 'fp1', sourceIdentityFingerprint: 'ifp1',
    descriptionRaw: 'x', finalCategory: 'Snacks',
  } as never);
  const node = await Category.findOne({ where: { householdId, name: 'Snacks' } });
  await assert.rejects(
    () => deleteCategory(householdId, node!.id),
    (e: unknown) => e instanceof CategoryError && e.code === 'has_references',
  );
});

test('blocks delete when a rule references the category id', async () => {
  await Rule.create({ householdId, merchantPattern: 'Shell', category: 'Fuel' } as never);
  const node = await Category.findOne({ where: { householdId, name: 'Fuel' } });
  await assert.rejects(
    () => deleteCategory(householdId, node!.id),
    (e: unknown) => e instanceof CategoryError && e.code === 'has_references',
  );
});

test('allows delete when no references and no children', async () => {
  const node = await Category.create({ householdId, name: 'Unused', icon: null, parentId: null });
  await deleteCategory(householdId, node.id);
  assert.equal(await Category.findByPk(node.id), null);
});
