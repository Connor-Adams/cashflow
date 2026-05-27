import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('users', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../../src/migrations/20260605000010-create-saved-searches.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates the saved_searches table', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    tables.includes('saved_searches'),
    `Expected saved_searches in: ${tables.join(', ')}`,
  );
});

test('saved_searches has expected columns', async () => {
  const description = await sequelize.getQueryInterface().describeTable('saved_searches');
  assert.equal(description.user_id?.allowNull, false);
  assert.equal(description.name?.allowNull, false);
  assert.equal(description.query?.allowNull, false);
  assert.equal(description.created_at?.allowNull, false);
  assert.equal(description.updated_at?.allowNull, false);
});

test('saved_searches has a unique index on (user_id, name)', async () => {
  const indexes = await sequelize.getQueryInterface().showIndex('saved_searches');
  const found = (indexes as Array<{ name: string; unique?: boolean }>).find(
    (i) => i.name === 'saved_searches_user_name',
  );
  assert.ok(found, 'Expected saved_searches_user_name index');
  assert.equal(found?.unique, true);
});

test('saved_searches supports inserting a row', async () => {
  await sequelize.query(`INSERT INTO users (id) VALUES (1)`);
  await sequelize.query(`
    INSERT INTO saved_searches
      (user_id, name, query, created_at, updated_at)
    VALUES
      (1, 'big-grocery-runs',
       'category:Groceries amount:>100 scope:business has:receipt',
       datetime('now'), datetime('now'))
  `);
  const [rows] = await sequelize.query(
    `SELECT name, query FROM saved_searches WHERE user_id = 1`,
  );
  const row = (rows as Array<{ name: string; query: string }>)[0];
  assert.equal(row.name, 'big-grocery-runs');
  assert.match(row.query, /category:Groceries/);
});

test('saved_searches rejects duplicate (user_id, name)', async () => {
  let threw = false;
  try {
    await sequelize.query(`
      INSERT INTO saved_searches
        (user_id, name, query, created_at, updated_at)
      VALUES (1, 'big-grocery-runs', 'other:query', datetime('now'), datetime('now'))
    `);
  } catch {
    threw = true;
  }
  assert.equal(threw, true, 'Duplicate (user_id, name) should be rejected');
});

test('down drops the table cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    !tables.includes('saved_searches'),
    `saved_searches should be gone, found: ${tables.join(', ')}`,
  );
});
