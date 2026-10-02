import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../db';
import { Account, Entity, Household, HouseholdMember, User } from '../../models';
import { resolveEntityPerson, resolvePersonalEntity } from './personalEntityOwner';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

let n = 0;
async function user(dob: string | null = null) {
  n += 1;
  return User.create({
    email: `peo-${n}@example.test`, displayName: `U${n}`,
    passwordHash: 'x', passwordSalt: 'x', passwordParams: 'x', dob,
  } as never);
}

async function personal(householdId: number, name: string) {
  return Entity.create({
    householdId, kind: 'personal', legalName: name, jurisdiction: 'CA-ON', fiscalYearEnd: null,
  } as never);
}

async function account(householdId: number, entityId: number, ownerUserId: number) {
  return Account.create({
    name: `A${entityId}-${ownerUserId}`, householdId, accountType: 'checking', entityId,
    ownerUserId, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
}

test('one personal entity: that entity, for any user', async () => {
  const hh = await Household.create({ name: 'one' });
  const e = await personal(hh.id, 'Only');
  const u = await user();
  assert.equal((await resolvePersonalEntity(hh.id, u.id))?.id, e.id);
});

test('no personal entity: null', async () => {
  const hh = await Household.create({ name: 'none' });
  const u = await user();
  assert.equal(await resolvePersonalEntity(hh.id, u.id), null);
});

test('two personal entities: each user gets the one holding their accounts', async () => {
  const hh = await Household.create({ name: 'two' });
  const a = await personal(hh.id, 'Connor');
  const b = await personal(hh.id, 'Partner');
  const connor = await user();
  const partner = await user();
  await account(hh.id, a.id, connor.id);
  await account(hh.id, b.id, partner.id);
  await account(hh.id, b.id, partner.id);

  assert.equal((await resolvePersonalEntity(hh.id, connor.id))?.id, a.id);
  assert.equal((await resolvePersonalEntity(hh.id, partner.id))?.id, b.id);
});

test('two personal entities and no owned accounts: the lowest id, every time', async () => {
  const hh = await Household.create({ name: 'tie' });
  const a = await personal(hh.id, 'First');
  await personal(hh.id, 'Second');
  const u = await user();
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await resolvePersonalEntity(hh.id, u.id))?.id, a.id);
  }
});

test('the entity person is the member owning its accounts, else the household owner', async () => {
  const hh = await Household.create({ name: 'person' });
  const e = await personal(hh.id, 'P');
  const first = await user('1950-01-01');
  const owner = await user('1990-01-01');
  await HouseholdMember.create({ householdId: hh.id, userId: first.id, role: 'member' } as never);
  await HouseholdMember.create({ householdId: hh.id, userId: owner.id, role: 'owner' } as never);

  assert.equal((await resolveEntityPerson(e))?.id, owner.id, 'no accounts: the household owner');

  await account(hh.id, e.id, first.id);
  assert.equal((await resolveEntityPerson(e))?.id, first.id, 'account ownership wins');
});
