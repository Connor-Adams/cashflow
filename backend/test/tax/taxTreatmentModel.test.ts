import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../src/db';
import { Category, Household } from '../../src/models';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

test('Category.taxTreatment defaults to "none" and is settable', async () => {
  const hh = await Household.create({ name: 'TT' });
  const a = await Category.create({ householdId: hh.id, name: 'Groceries' } as never);
  assert.equal(a.taxTreatment, 'none', 'defaults to none');

  const b = await Category.create({
    householdId: hh.id, name: 'Charity', taxTreatment: 'donations',
  } as never);
  assert.equal(b.taxTreatment, 'donations');
});
