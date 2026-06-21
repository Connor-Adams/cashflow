/**
 * Round-trip test for migration 20260621000001-add-household-timezone
 * (audit wave 3). Adds nullable `timezone` to `households` on in-memory
 * SQLite, asserts shape + nullability + round-trips a value, then down()
 * removes it cleanly while untouched data survives.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  await sequelize.getQueryInterface().createTable('households', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(160), allowNull: false },
    benchmark_symbol: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'SPY',
    },
  });
  await sequelize.query(`INSERT INTO households (name, benchmark_symbol) VALUES ('Smiths', 'SPY')`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260621000001-add-household-timezone.js');
});

after(async () => {
  await sequelize.close();
});

test('up: adds a nullable timezone column', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('households');
  assert.ok('timezone' in desc, 'timezone column missing');
  assert.equal(desc.timezone.allowNull, true, 'timezone must be nullable');
});

test('up: pre-existing rows get NULL timezone', async () => {
  const [rows] = (await sequelize.query(
    `SELECT name, timezone FROM households`,
  )) as [Array<{ name: string; timezone: string | null }>, unknown];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].timezone, null);
});

test('timezone accepts an IANA string', async () => {
  await sequelize.query(`UPDATE households SET timezone = 'America/Toronto' WHERE name = 'Smiths'`);
  const [rows] = (await sequelize.query(
    `SELECT timezone FROM households WHERE name = 'Smiths'`,
  )) as [Array<{ timezone: string | null }>, unknown];
  assert.equal(rows[0].timezone, 'America/Toronto');
});

test('down: removes the column cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('households');
  assert.ok(!('timezone' in desc), 'timezone should be removed');
});

test('down: untouched data survives', async () => {
  const [rows] = (await sequelize.query(
    `SELECT name, benchmark_symbol FROM households`,
  )) as [Array<{ name: string; benchmark_symbol: string }>, unknown];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Smiths');
  assert.equal(rows[0].benchmark_symbol, 'SPY');
});
