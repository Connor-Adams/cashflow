import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { ExternalOrder, ExternalOrderItem, Household, Category } from '../models';
import { resetTestDb } from '../../test/helpers/resetTestDb';

let householdId: number, orderId: number, child: number;
beforeEach(async () => {
  await resetTestDb(sequelize);
  householdId = (await Household.create({ name: 'T' })).id;
  orderId = (await ExternalOrder.create({ householdId, vendor: 'amazon', source: 'amazon', dedupeKey: 'o1' } as never)).id;
  const work = await Category.create({ householdId, name: 'Work', icon: null, parentId: null });
  child = (await Category.create({ householdId, name: 'Internet', icon: null, parentId: work.id })).id;
});

test('explicit child categoryOverrideId sticks + derives string', async () => {
  const item = await ExternalOrderItem.create({ externalOrderId: orderId, title: 'X', categoryOverrideId: child } as never);
  assert.equal(item.categoryOverrideId, child);
  assert.equal(item.categoryOverride, 'Internet');
});
