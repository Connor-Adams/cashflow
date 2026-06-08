import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../db';
import { Entity, Household } from '../../models';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

test('two corps in the same household can share an associatedGroupId', async () => {
  const h = await Household.create({ name: 'H' });
  const opco = await Entity.create({
    householdId: h.id,
    kind: 'corp',
    legalName: 'Opco',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
    associatedGroupId: 'opco-holdco-group',
  });
  const holdco = await Entity.create({
    householdId: h.id,
    kind: 'corp',
    legalName: 'Holdco',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
    associatedGroupId: 'opco-holdco-group',
  });
  const reloadedOpco = await Entity.findByPk(opco.id);
  const reloadedHoldco = await Entity.findByPk(holdco.id);
  assert.equal(reloadedOpco?.associatedGroupId, 'opco-holdco-group');
  assert.equal(reloadedHoldco?.associatedGroupId, 'opco-holdco-group');
});

test('setting associatedGroupId on a personal entity is allowed at DB level (engine ignores)', async () => {
  // DB column is a plain nullable string; kind-validation lives in higher-level
  // routes (P11b T7) and engine logic, not at the model layer. Storing it on a
  // personal entity must succeed — the engine just ignores it.
  const h = await Household.create({ name: 'H' });
  const person = await Entity.create({
    householdId: h.id,
    kind: 'personal',
    legalName: 'Alice',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
    associatedGroupId: 'ignored-on-personal',
  });
  const reloaded = await Entity.findByPk(person.id);
  assert.equal(reloaded?.associatedGroupId, 'ignored-on-personal');
});
