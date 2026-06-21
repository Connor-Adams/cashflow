// backend/src/ai/loadCategoryHints.paths.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Household, Category } from '../models';
import { loadCategoryHints } from './suggestTransaction';

let householdId: number;
beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
  const work = await Category.create({ householdId, name: 'Work', icon: null, parentId: null });
  const expenses = await Category.create({ householdId, name: 'Expenses', icon: null, parentId: work.id });
  await Category.create({ householdId, name: 'Internet', icon: null, parentId: expenses.id });
});

test('returns full paths for nested categories', async () => {
  const hints = await loadCategoryHints(householdId);
  assert.ok(hints.includes('Work / Expenses / Internet'));
  assert.ok(hints.includes('Work'));
});
