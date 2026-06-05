import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Entity, Household } from '../models';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

test('Entity.ownerEntityId defaults null and is settable', async () => {
  const hh = await Household.create({ name: 'O' });
  const personal = await Entity.create({
    householdId: hh.id, kind: 'personal', legalName: 'Me', jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const corp = await Entity.create({
    householdId: hh.id, kind: 'corp', legalName: 'Co', jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  assert.equal(corp.ownerEntityId, null, 'defaults null');
  await corp.update({ ownerEntityId: personal.id });
  assert.equal(corp.ownerEntityId, personal.id);
});
