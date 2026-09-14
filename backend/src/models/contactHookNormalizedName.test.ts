import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize } from 'sequelize';
import { initContact } from './Contact.js';

let sequelize: Sequelize;
let Contact: ReturnType<typeof initContact>;

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  Contact = initContact(sequelize);
  await sequelize.sync();
});
after(async () => { await sequelize.close(); });

test('beforeValidate sets normalizedName from name', async () => {
  const c = await Contact.create({ householdId: 1, name: '  Jane   DOE ', notes: null } as never);
  assert.equal(c.normalizedName, 'jane doe');
});

/**
 * Re-reads the row instead of trusting the in-memory instance. The hook always
 * mutates the instance, so an instance-only assertion passes even when the
 * derived column is dropped from the UPDATE statement — which is exactly how a
 * rename silently failed to persist normalized_name in production.
 */
test('rename persists normalizedName to the database', async () => {
  const c = await Contact.create({ householdId: 1, name: 'Bob', notes: null } as never);
  c.set('name', 'Bobby Tables');
  await c.save();
  const fresh = await Contact.findByPk(c.id);
  assert.equal(fresh?.name, 'Bobby Tables');
  assert.equal(fresh?.normalizedName, 'bobby tables');
});

test('rename persists normalizedName when save() is scoped to the name field', async () => {
  const c = await Contact.create({ householdId: 1, name: 'Ann', notes: null } as never);
  c.set('name', 'Ann Other');
  await c.save({ fields: ['name'] });
  const fresh = await Contact.findByPk(c.id);
  assert.equal(fresh?.normalizedName, 'ann other');
});

test('update() through the model persists normalizedName', async () => {
  const c = await Contact.create({ householdId: 1, name: 'Cy', notes: null } as never);
  await c.update({ name: 'Cy Young' });
  const fresh = await Contact.findByPk(c.id);
  assert.equal(fresh?.normalizedName, 'cy young');
});

test('saving an unrelated field leaves normalizedName consistent with name', async () => {
  const c = await Contact.create({ householdId: 1, name: 'Dee Dee', notes: null } as never);
  c.set('notes', 'hello');
  await c.save();
  const fresh = await Contact.findByPk(c.id);
  assert.equal(fresh?.normalizedName, 'dee dee');
});
