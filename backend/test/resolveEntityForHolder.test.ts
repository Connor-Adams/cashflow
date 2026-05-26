import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let Entity: typeof import('../src/models/Entity').Entity;
let Household: typeof import('../src/models/Household').Household;
let resolveEntityForHolder: typeof import('../src/import/runImport').resolveEntityForHolder;

before(async () => {
  const models = await import('../src/models');
  sequelize = models.sequelize;
  Entity = models.Entity;
  Household = models.Household;
  const ri = await import('../src/import/runImport');
  resolveEntityForHolder = ri.resolveEntityForHolder;
  await sequelize.sync({ force: true });
});

after(async () => {
  await sequelize.close();
});

let householdId: number;
beforeEach(async () => {
  await Entity.destroy({ where: {}, truncate: true });
  await Household.destroy({ where: {}, truncate: true });
  const hh = await Household.create({ name: 'H' });
  householdId = hh.id;
});

test('resolveEntityForHolder: null/empty holder returns null', async () => {
  assert.equal(await resolveEntityForHolder(null, householdId), null);
  assert.equal(await resolveEntityForHolder(undefined, householdId), null);
  assert.equal(await resolveEntityForHolder('', householdId), null);
  assert.equal(await resolveEntityForHolder('   ', householdId), null);
});

test('resolveEntityForHolder: returns existing entity by exact legalName match', async () => {
  const existing = await Entity.create({
    householdId,
    kind: 'corp',
    legalName: 'CDG Labs Inc.',
  });
  const got = await resolveEntityForHolder('CDG Labs Inc.', householdId);
  assert.ok(got);
  assert.equal(got!.id, existing.id);
  assert.equal(got!.kind, 'corp');
});

test('resolveEntityForHolder: auto-creates corp entity for "Inc." suffix', async () => {
  const got = await resolveEntityForHolder('CDG Labs Inc.', householdId);
  assert.ok(got);
  assert.equal(got!.kind, 'corp');
  assert.equal(got!.legalName, 'CDG Labs Inc.');
  assert.equal(got!.householdId, householdId);
  const all = await Entity.findAll();
  assert.equal(all.length, 1);
});

test('resolveEntityForHolder: idempotent — second call reuses created entity', async () => {
  const first = await resolveEntityForHolder('CDG Labs Inc.', householdId);
  const second = await resolveEntityForHolder('CDG Labs Inc.', householdId);
  assert.equal(first!.id, second!.id);
  const all = await Entity.findAll();
  assert.equal(all.length, 1);
});

test('resolveEntityForHolder: auto-creates corp entity for "Corp", "Ltd", "LLC", "GmbH", "Pty"', async () => {
  for (const name of [
    'Acme Corp',
    'Foo Ltd.',
    'Bar LLC',
    'Baz GmbH',
    'Quux Pty',
    'S Corporation',
  ]) {
    const got = await resolveEntityForHolder(name, householdId);
    assert.ok(got, `expected corp entity for ${name}`);
    assert.equal(got!.kind, 'corp');
  }
});

test('resolveEntityForHolder: personal holder (no corp suffix) returns null without creating', async () => {
  const got = await resolveEntityForHolder('Connor Adams', householdId);
  assert.equal(got, null);
  const all = await Entity.findAll();
  assert.equal(all.length, 0);
});

test('resolveEntityForHolder: matches existing personal entity by name even without corp suffix', async () => {
  const personal = await Entity.create({
    householdId,
    kind: 'personal',
    legalName: 'Connor Adams',
  });
  const got = await resolveEntityForHolder('Connor Adams', householdId);
  assert.ok(got);
  assert.equal(got!.id, personal.id);
  assert.equal(got!.kind, 'personal');
});

test('resolveEntityForHolder: trims whitespace before matching', async () => {
  await Entity.create({
    householdId,
    kind: 'corp',
    legalName: 'CDG Labs Inc.',
  });
  const got = await resolveEntityForHolder('  CDG Labs Inc.  ', householdId);
  assert.ok(got);
  assert.equal(got!.legalName, 'CDG Labs Inc.');
});
