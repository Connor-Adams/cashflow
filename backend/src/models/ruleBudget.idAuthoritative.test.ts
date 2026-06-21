// backend/src/models/ruleBudget.idAuthoritative.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Rule, BudgetTarget, Household, Category } from '../models';

let householdId: number, child: number;
beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
  const work = await Category.create({ householdId, name: 'Work', icon: null, parentId: null });
  child = (await Category.create({ householdId, name: 'Internet', icon: null, parentId: work.id })).id;
});

test('Rule explicit child categoryId sticks + derives string', async () => {
  const r = await Rule.create({ householdId, merchantPattern: 'isp-rule', categoryId: child } as never);
  assert.equal(r.categoryId, child);
  assert.equal(r.category, 'Internet');
});

test('BudgetTarget explicit child categoryId sticks + derives string', async () => {
  const b = await BudgetTarget.create({ householdId, categoryId: child, currency: 'CAD', amount: '50' } as never);
  assert.equal(b.categoryId, child);
  assert.equal(b.category, 'Internet');
});
