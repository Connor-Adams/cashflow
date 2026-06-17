import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...a: any[]) => Promise<void>; down: (...a: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('categories', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    parent_id: { type: DataTypes.INTEGER, allowNull: true },
    name: { type: DataTypes.STRING(128), allowNull: false },
    name_key: { type: DataTypes.STRING(128), allowNull: false },
  });
  await qi.createTable('transactions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    auto_category: { type: DataTypes.STRING(128), allowNull: true },
    category_override: { type: DataTypes.STRING(128), allowNull: true },
    final_category: { type: DataTypes.STRING(128), allowNull: true },
  });
  await qi.createTable('external_order_items', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    inferred_category: { type: DataTypes.STRING(128), allowNull: true },
    category_override: { type: DataTypes.STRING(128), allowNull: true },
  });
  await qi.createTable('rules', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    category: { type: DataTypes.STRING(128), allowNull: true },
  });
  await qi.createTable('budget_targets', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    category: { type: DataTypes.STRING(128), allowNull: true },
  });
  await qi.bulkInsert('categories', [
    { household_id: 1, parent_id: null, name: 'Groceries', name_key: 'groceries' },
    { household_id: 1, parent_id: null, name: 'Dining', name_key: 'dining' },
  ]);
  await qi.bulkInsert('transactions', [
    { household_id: 1, auto_category: 'Groceries', category_override: null, final_category: 'Groceries' },
    { household_id: 1, auto_category: null, category_override: 'Dining', final_category: 'Dining' },
    { household_id: 1, auto_category: null, category_override: null, final_category: null },
  ]);
  await qi.bulkInsert('rules', [{ household_id: 1, category: 'Dining' }]);
  await qi.bulkInsert('budget_targets', [{ household_id: 1, category: 'Groceries' }, { household_id: 1, category: null }]);
  await qi.bulkInsert('external_order_items', [{ inferred_category: 'Groceries', category_override: 'Dining' }]);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260622000001-category-id-columns.js');
});

after(async () => { await sequelize.close(); });

test('up adds all FK columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const txn = await sequelize.getQueryInterface().describeTable('transactions');
  assert.ok('auto_category_id' in txn && 'category_override_id' in txn && 'final_category_id' in txn);
  const item = await sequelize.getQueryInterface().describeTable('external_order_items');
  assert.ok('inferred_category_id' in item && 'category_override_id' in item);
  const rule = await sequelize.getQueryInterface().describeTable('rules');
  assert.ok('category_id' in rule);
  const bt = await sequelize.getQueryInterface().describeTable('budget_targets');
  assert.ok('category_id' in bt);
});

test('backfill maps string columns to root category ids', async () => {
  const [cats] = await sequelize.query("SELECT id, name FROM categories ORDER BY name");
  const idByName = Object.fromEntries((cats as Array<{ id: number; name: string }>).map(c => [c.name, c.id]));
  const [txns] = await sequelize.query("SELECT final_category, final_category_id, category_override, category_override_id FROM transactions ORDER BY id");
  const t = txns as Array<Record<string, unknown>>;
  assert.equal(t[0].final_category_id, idByName['Groceries']);
  assert.equal(t[1].category_override_id, idByName['Dining']);
  assert.equal(t[1].final_category_id, idByName['Dining']);
  assert.equal(t[2].final_category_id, null); // null stays null
  const [rules] = await sequelize.query("SELECT category, category_id FROM rules");
  assert.equal((rules as Array<Record<string, unknown>>)[0].category_id, idByName['Dining']);
  const [bts] = await sequelize.query("SELECT category, category_id FROM budget_targets ORDER BY id");
  assert.equal((bts as Array<Record<string, unknown>>)[0].category_id, idByName['Groceries']);
  assert.equal((bts as Array<Record<string, unknown>>)[1].category_id, null); // null "overall" stays null
  const [items] = await sequelize.query("SELECT inferred_category_id, category_override_id FROM external_order_items");
  assert.equal((items as Array<Record<string, unknown>>)[0].inferred_category_id, idByName['Groceries']);
  assert.equal((items as Array<Record<string, unknown>>)[0].category_override_id, idByName['Dining']);
});

test('down removes all FK columns', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const txn = await sequelize.getQueryInterface().describeTable('transactions');
  assert.ok(!('final_category_id' in txn));
});
