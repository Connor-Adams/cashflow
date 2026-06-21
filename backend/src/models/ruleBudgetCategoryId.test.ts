// backend/src/models/ruleBudgetCategoryId.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Rule, BudgetTarget, Household, Category } from '../models';

let householdId: number;
beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
});

test('Rule.categoryId set from category string', async () => {
  const r = await Rule.create({ householdId, merchantPattern: 'test-rule', category: 'Dining' } as never);
  assert.ok(r.categoryId);
  assert.equal((await Category.findByPk(r.categoryId!))?.name, 'Dining');
});

test('BudgetTarget.categoryId set from category; null stays overall', async () => {
  const scoped = await BudgetTarget.create({ householdId, category: 'Groceries', currency: 'CAD', amount: '100' } as never);
  assert.ok(scoped.categoryId);
  const overall = await BudgetTarget.create({ householdId, category: null, currency: 'CAD', amount: '200' } as never);
  assert.equal(overall.categoryId, null);
});
