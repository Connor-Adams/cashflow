import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, User, HouseholdMember, Contact, Household } from '../../models';
import { loadHouseholdOwnerNames } from './loaders';

before(async () => {
  await sequelize.sync({ force: true });
});

let seq = 0;
async function makeOwner(displayName: string): Promise<{ householdId: number; userId: number }> {
  seq += 1;
  const user = await User.create({
    email: `owner-${seq}@example.com`,
    displayName,
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: 'x',
  } as never);
  const household = await Household.create({ name: `hh-${seq}` } as never);
  await HouseholdMember.create({
    userId: user.id,
    householdId: household.id,
    role: 'owner',
  } as never);
  return { householdId: household.id, userId: user.id };
}

test('includes member user display names AND partner contacts, excludes non-partner contacts', async () => {
  const { householdId } = await makeOwner('Connor Adams');
  await Contact.create({ householdId, name: 'LingLing', isPartner: true, notes: null } as never);
  await Contact.create({ householdId, name: 'Dad', isPartner: false, notes: null } as never);

  const names = await loadHouseholdOwnerNames(householdId);

  assert.ok(names.includes('Connor Adams'), 'member user name present');
  assert.ok(names.includes('LingLing'), 'partner contact name present');
  assert.ok(!names.includes('Dad'), 'non-partner contact excluded');
});

test('single-member household with no partner contact returns just the member', async () => {
  const { householdId } = await makeOwner('Solo Owner');
  const names = await loadHouseholdOwnerNames(householdId);
  assert.deepEqual(names, ['Solo Owner']);
});

test('null household id returns empty', async () => {
  assert.deepEqual(await loadHouseholdOwnerNames(null), []);
});
