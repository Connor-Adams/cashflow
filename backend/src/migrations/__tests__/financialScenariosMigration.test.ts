/**
 * Round-trip test for migration:
 *   20260608000001-create-financial-scenarios
 *
 * Uses an in-memory SQLite DB. Stubs the parent tables referenced by FKs
 * (households, users), then runs `up` + asserts schema + `down` + asserts
 * the table is gone.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
let migration: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  up: (...args: any[]) => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  down: (...args: any[]) => Promise<void>;
};

before(async () => {
  sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  const qi = sequelize.getQueryInterface();
  // Parent tables for FK references.
  await qi.createTable('households', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  await qi.createTable('users', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260608000001-create-financial-scenarios.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates financial_scenarios table with expected columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    tables.includes('financial_scenarios'),
    `Expected financial_scenarios in: ${tables.join(', ')}`,
  );
  const cols = await sequelize.getQueryInterface().describeTable('financial_scenarios');
  for (const col of [
    'id',
    'household_id',
    'user_id',
    'name',
    'assumptions_json',
    'result_json',
    'created_at',
    'updated_at',
  ]) {
    assert.ok(col in cols, `Expected column ${col} in financial_scenarios`);
  }
});

test('row can be inserted and read back', async () => {
  await sequelize.query(`INSERT INTO households (id) VALUES (1)`);
  await sequelize.query(`INSERT INTO users (id) VALUES (1)`);
  await sequelize.query(
    `INSERT INTO financial_scenarios
       (household_id, user_id, name, assumptions_json, result_json, created_at, updated_at)
     VALUES (1, 1, 'Test scenario', '{"name":"Test","overrides":[]}', NULL, datetime('now'), datetime('now'))`,
  );
  const [rows] = (await sequelize.query(
    `SELECT name, assumptions_json, result_json FROM financial_scenarios`,
  )) as [{ name: string; assumptions_json: string; result_json: string | null }[], unknown];
  assert.equal(rows[0]?.name, 'Test scenario');
  assert.equal(rows[0]?.result_json, null);
});

test('household_id CASCADE deletes scenarios when household is removed', async () => {
  // Enable FK constraints in SQLite.
  await sequelize.query('PRAGMA foreign_keys = ON;');
  await sequelize.query(`INSERT INTO households (id) VALUES (2)`);
  await sequelize.query(`INSERT INTO users (id) VALUES (2)`);
  await sequelize.query(
    `INSERT INTO financial_scenarios
       (household_id, user_id, name, assumptions_json, result_json, created_at, updated_at)
     VALUES (2, 2, 'Cascaded', '{"name":"Cascaded","overrides":[]}', NULL, datetime('now'), datetime('now'))`,
  );
  await sequelize.query(`DELETE FROM households WHERE id = 2`);
  const [rows] = (await sequelize.query(
    `SELECT id FROM financial_scenarios WHERE household_id = 2`,
  )) as [{ id: number }[], unknown];
  assert.equal(rows.length, 0, 'Household delete should cascade to financial_scenarios');
});

test('down drops the table', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    !tables.includes('financial_scenarios'),
    `Table should be gone, found: ${tables.join(', ')}`,
  );
});
