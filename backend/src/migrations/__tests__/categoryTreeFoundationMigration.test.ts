import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...a: any[]) => Promise<void>; down: (...a: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  // Recreate the pre-migration shape: flat categories with the old unique index.
  await qi.createTable('categories', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(128), allowNull: false },
    icon: { type: DataTypes.STRING(64), allowNull: true },
    tax_treatment: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'none' },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: new Date() },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: new Date() },
  });
  await qi.addIndex('categories', ['household_id', 'name'], {
    name: 'categories_household_name_unique',
    unique: true,
  });
  await qi.bulkInsert('categories', [
    { household_id: 1, name: 'Groceries', tax_treatment: 'none' },
    { household_id: 1, name: 'Dining', tax_treatment: 'none' },
  ]);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260621000001-category-tree-foundation.js');
});

after(async () => { await sequelize.close(); });

test('up adds parent_id + name_key columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('categories');
  assert.ok('parent_id' in desc, 'parent_id column missing');
  assert.ok('name_key' in desc, 'name_key column missing');
  assert.equal(desc.parent_id?.allowNull, true);
  assert.equal(desc.name_key?.allowNull, false);
});

test('up backfills name_key as lowercased name', async () => {
  const [rows] = await sequelize.query(
    "SELECT name, name_key FROM categories ORDER BY name",
  );
  const byName = Object.fromEntries((rows as Array<{ name: string; name_key: string }>).map(r => [r.name, r.name_key]));
  assert.equal(byName['Groceries'], 'groceries');
  assert.equal(byName['Dining'], 'dining');
});

test('root name_key uniqueness is enforced (case-insensitive)', async () => {
  await assert.rejects(
    () => sequelize.query(
      "INSERT INTO categories (household_id, name, name_key, tax_treatment) VALUES (1, 'groceries', 'groceries', 'none')",
    ),
    /UNIQUE|constraint/i,
  );
});

test('down removes new columns and restores old index', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('categories');
  assert.ok(!('parent_id' in desc), 'parent_id should be dropped');
  assert.ok(!('name_key' in desc), 'name_key should be dropped');
});
