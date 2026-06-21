import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Category, Household } from '../models';
import { wouldCreateCycle } from './cycle';

let householdId: number;
let work: Category, expenses: Category, internet: Category, home: Category;

beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
  work = await Category.create({ householdId, name: 'Work', icon: null, parentId: null });
  expenses = await Category.create({ householdId, name: 'Expenses', icon: null, parentId: work.id });
  internet = await Category.create({ householdId, name: 'Internet', icon: null, parentId: expenses.id });
  home = await Category.create({ householdId, name: 'Home', icon: null, parentId: null });
});

test('reparenting a node under itself is a cycle', async () => {
  assert.equal(await wouldCreateCycle(householdId, work.id, work.id), true);
});

test('reparenting a node under its own descendant is a cycle', async () => {
  assert.equal(await wouldCreateCycle(householdId, work.id, internet.id), true);
});

test('reparenting under an unrelated node is not a cycle', async () => {
  assert.equal(await wouldCreateCycle(householdId, expenses.id, home.id), false);
});
