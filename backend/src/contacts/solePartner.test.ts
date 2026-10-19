import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, Contact, Household } from '../models';
import { findSolePartnerContactId, ownershipContactIdFor } from './solePartner';

before(async () => {
  await sequelize.sync({ force: true });
});

async function household(name: string): Promise<number> {
  const h = await Household.create({ name } as never);
  return h.id;
}

test('findSolePartnerContactId: the partner when there is exactly one', async () => {
  const householdId = await household('One');
  const partner = await Contact.create({ householdId, name: 'Sam', isPartner: true } as never);
  await Contact.create({ householdId, name: 'Friend', isPartner: false } as never);
  assert.equal(await findSolePartnerContactId(householdId), partner.id);
});

test('findSolePartnerContactId: null with no partner, two partners, or no household', async () => {
  const none = await household('None');
  await Contact.create({ householdId: none, name: 'Friend', isPartner: false } as never);
  assert.equal(await findSolePartnerContactId(none), null);

  const two = await household('Two');
  await Contact.create({ householdId: two, name: 'Sam', isPartner: true } as never);
  await Contact.create({ householdId: two, name: 'Alex', isPartner: true } as never);
  assert.equal(await findSolePartnerContactId(two), null);

  assert.equal(await findSolePartnerContactId(null), null);
});

test('findSolePartnerContactId: ignores partners from other households', async () => {
  const mine = await household('Mine');
  const other = await household('Other');
  const partner = await Contact.create({ householdId: mine, name: 'Sam', isPartner: true } as never);
  await Contact.create({ householdId: other, name: 'Alex', isPartner: true } as never);
  assert.equal(await findSolePartnerContactId(mine), partner.id);
});

test('ownershipContactIdFor: partner/shared splits get the sole partner, me gets nothing', () => {
  assert.equal(ownershipContactIdFor('partner', 7), 7);
  assert.equal(ownershipContactIdFor('shared', 7), 7);
  assert.equal(ownershipContactIdFor('me', 7), null);
  assert.equal(ownershipContactIdFor('partner', null), null);
});
