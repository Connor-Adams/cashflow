import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, Contact, Household, User } from '../models';
import { resolveOrCreatePartnerContact } from './linkPartnerContact';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

test('adopts an existing unlinked isPartner contact', async () => {
  const hh = await Household.create({ name: 'H' });
  const u = await User.create({ email: 'p@x.io', displayName: 'Pat', globalRole: 'user', passwordHash: 'h', passwordSalt: 's', passwordParams: 'p' });
  const existing = await Contact.create({ householdId: hh.id, name: 'Pat', isPartner: true });
  const out = await sequelize.transaction((transaction) =>
    resolveOrCreatePartnerContact({ householdId: hh.id, userId: u.id, displayName: 'Pat', transaction }),
  );
  assert.equal(out.id, existing.id);
  assert.equal(out.userId, u.id);
});

test('creates a new partner contact when none exists', async () => {
  const hh = await Household.create({ name: 'H' });
  const u = await User.create({ email: 'p2@x.io', displayName: 'Sam', globalRole: 'user', passwordHash: 'h', passwordSalt: 's', passwordParams: 'p' });
  const out = await sequelize.transaction((transaction) =>
    resolveOrCreatePartnerContact({ householdId: hh.id, userId: u.id, displayName: 'Sam', transaction }),
  );
  assert.equal(out.isPartner, true);
  assert.equal(out.userId, u.id);
  assert.equal(out.name, 'Sam');
});

test('does not adopt a contact already linked to another user', async () => {
  const hh = await Household.create({ name: 'H' });
  const other = await User.create({ email: 'o@x.io', displayName: 'O', globalRole: 'user', passwordHash: 'h', passwordSalt: 's', passwordParams: 'p' });
  const u = await User.create({ email: 'p3@x.io', displayName: 'New', globalRole: 'user', passwordHash: 'h', passwordSalt: 's', passwordParams: 'p' });
  await Contact.create({ householdId: hh.id, name: 'Taken', isPartner: true, userId: other.id });
  const out = await sequelize.transaction((transaction) =>
    resolveOrCreatePartnerContact({ householdId: hh.id, userId: u.id, displayName: 'New', transaction }),
  );
  assert.equal(out.userId, u.id);
  assert.notEqual(out.name, 'Taken');
});
