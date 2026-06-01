import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize } from 'sequelize';
import { initContact } from '../src/models/Contact.js';

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
test('rename updates normalizedName', async () => {
  const c = await Contact.create({ householdId: 1, name: 'Bob', notes: null } as never);
  c.set('name', 'Bobby Tables');
  await c.save();
  assert.equal(c.normalizedName, 'bobby tables');
});
