import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { ExternalOrder, ExternalOrderItem, Household, Category } from '../models';

let householdId: number;
let orderId: number;
beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
  orderId = (
    await ExternalOrder.create({
      householdId,
      vendor: 'amazon',
      source: 'amazon',
      dedupeKey: 'o1',
    } as never)
  ).id;
});

test('beforeSave resolves item category ids via parent order household', async () => {
  const item = await ExternalOrderItem.create({
    externalOrderId: orderId,
    title: 'Milk',
    inferredCategory: 'Groceries',
    categoryOverride: 'Dining',
  } as never);
  assert.ok(item.inferredCategoryId);
  assert.ok(item.categoryOverrideId);
  assert.equal((await Category.findByPk(item.inferredCategoryId!))?.householdId, householdId);
  assert.equal((await Category.findByPk(item.categoryOverrideId!))?.name, 'Dining');
});

test('null categories leave ids null', async () => {
  const item = await ExternalOrderItem.create({
    externalOrderId: orderId,
    title: 'X',
    inferredCategory: null,
    categoryOverride: null,
  } as never);
  assert.equal(item.inferredCategoryId, null);
  assert.equal(item.categoryOverrideId, null);
});
