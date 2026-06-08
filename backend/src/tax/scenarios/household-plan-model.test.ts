import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../db';
import { Household, HouseholdPlan } from '../../models';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

test('creates and reads back a HouseholdPlan', async () => {
  const h = await Household.create({ name: 'H' });
  const plan = await HouseholdPlan.create({
    householdId: h.id,
    name: 'Plan A',
    notes: null,
  });
  const back = await HouseholdPlan.findByPk(plan.id);
  assert.equal(back?.name, 'Plan A');
  assert.equal(back?.householdId, h.id);
  assert.equal(back?.notes, null);
});

test('cascade delete: deleting Household removes its plans', async () => {
  const h = await Household.create({ name: 'H' });
  await HouseholdPlan.create({
    householdId: h.id,
    name: 'P',
    notes: null,
  });
  await h.destroy();
  const remaining = await HouseholdPlan.findAll();
  assert.equal(remaining.length, 0);
});
