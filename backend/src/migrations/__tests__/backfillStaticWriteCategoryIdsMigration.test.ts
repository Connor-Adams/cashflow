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
    auto_category_id: { type: DataTypes.INTEGER, allowNull: true },
    category_override: { type: DataTypes.STRING(128), allowNull: true },
    category_override_id: { type: DataTypes.INTEGER, allowNull: true },
    final_category: { type: DataTypes.STRING(128), allowNull: true },
    final_category_id: { type: DataTypes.INTEGER, allowNull: true },
  });
  await qi.createTable('external_order_items', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    inferred_category: { type: DataTypes.STRING(128), allowNull: true },
    inferred_category_id: { type: DataTypes.INTEGER, allowNull: true },
    category_override: { type: DataTypes.STRING(128), allowNull: true },
    category_override_id: { type: DataTypes.INTEGER, allowNull: true },
  });
  await qi.createTable('rules', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    category: { type: DataTypes.STRING(128), allowNull: true },
    category_id: { type: DataTypes.INTEGER, allowNull: true },
  });
  await qi.createTable('budget_targets', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    category: { type: DataTypes.STRING(128), allowNull: true },
    category_id: { type: DataTypes.INTEGER, allowNull: true },
  });
  await qi.bulkInsert('categories', [{ household_id: 1, parent_id: null, name: 'Groceries', name_key: 'groceries' }]);
  // a row that a static update left with the string set but the id null
  await qi.bulkInsert('transactions', [{ household_id: 1, auto_category: 'Groceries', auto_category_id: null, final_category: 'Groceries', final_category_id: null }]);
  // external_order_items uses the hasHousehold=false / match-by-name_key path
  await qi.bulkInsert('external_order_items', [{ inferred_category: 'Groceries', inferred_category_id: null }]);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260623000001-backfill-static-write-category-ids.js');
});
after(async () => { await sequelize.close(); });

test('backfills null *_category_id where the string is set', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const [rows] = await sequelize.query('SELECT auto_category_id, final_category_id FROM transactions');
  const cat = (await sequelize.query('SELECT id FROM categories'))[0] as Array<{ id: number }>;
  assert.equal((rows as Array<Record<string, unknown>>)[0].auto_category_id, cat[0].id);
  assert.equal((rows as Array<Record<string, unknown>>)[0].final_category_id, cat[0].id);
});

test('backfills external_order_items inferred_category_id via name_key match (hasHousehold=false path)', async () => {
  // migration.up was already called in the previous test; re-run is idempotent (id already set)
  const [items] = await sequelize.query('SELECT inferred_category_id FROM external_order_items');
  const cat = (await sequelize.query('SELECT id FROM categories'))[0] as Array<{ id: number }>;
  assert.equal(
    (items as Array<Record<string, unknown>>)[0].inferred_category_id,
    cat[0].id,
    'inferred_category_id should be backfilled to the matching root category id',
  );
});
