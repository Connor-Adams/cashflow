/**
 * Migration round-trip for #375: adds `is_partner` BOOLEAN NOT NULL DEFAULT false
 * to the `contacts` table. Asserts the schema, the safe default, and that the
 * down migration removes the column cleanly.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  // Minimal `households` parent table so the FK on contacts is satisfiable.
  await qi.createTable('households', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  // Bring `contacts` up to the pre-#375 shape — the columns we care about
  // for the assertion. `notes` matches the production schema; we omit the
  // FK because SQLite doesn't enforce it without PRAGMA foreign_keys.
  await qi.createTable('contacts', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(160), allowNull: false },
    notes: { type: DataTypes.TEXT, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260606000001-contacts-is-partner.js');
});

after(async () => {
  await sequelize.close();
});

test('up adds is_partner BOOLEAN NOT NULL DEFAULT false to contacts', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const description = await sequelize.getQueryInterface().describeTable('contacts');
  const col = description.is_partner;
  assert.ok(col, 'is_partner column missing');
  assert.equal(col.allowNull, false);
  // Default may surface as "0" or false depending on SQLite driver — both fine.
  assert.ok(col.defaultValue === false || col.defaultValue === 0 || col.defaultValue === '0');
});

test('inserting a row without is_partner defaults to false', async () => {
  await sequelize.query(`INSERT INTO households (id) VALUES (1)`);
  await sequelize.query(`
    INSERT INTO contacts (household_id, name, notes, created_at, updated_at)
    VALUES (1, 'Test', NULL, datetime('now'), datetime('now'))
  `);
  const [rows] = await sequelize.query(
    `SELECT is_partner FROM contacts WHERE name = 'Test'`,
  );
  const row = (rows as Array<{ is_partner: number | boolean }>)[0];
  // SQLite returns boolean as 0/1.
  assert.ok(row.is_partner === 0 || row.is_partner === false);
});

test('inserting is_partner=1 round-trips as truthy', async () => {
  await sequelize.query(`
    INSERT INTO contacts (household_id, name, notes, is_partner, created_at, updated_at)
    VALUES (1, 'Spouse', NULL, 1, datetime('now'), datetime('now'))
  `);
  const [rows] = await sequelize.query(
    `SELECT is_partner FROM contacts WHERE name = 'Spouse'`,
  );
  const row = (rows as Array<{ is_partner: number | boolean }>)[0];
  assert.ok(row.is_partner === 1 || row.is_partner === true);
});

test('down removes the is_partner column cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const description = await sequelize.getQueryInterface().describeTable('contacts');
  assert.equal(description.is_partner, undefined, 'is_partner should be gone after down');
});
