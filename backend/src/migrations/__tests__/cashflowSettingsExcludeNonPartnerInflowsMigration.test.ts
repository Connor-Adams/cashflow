/**
 * Migration round-trip for #375: adds `exclude_non_partner_inflows` BOOLEAN
 * NOT NULL DEFAULT true to the `cashflow_settings` table.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createSettingsTable: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('users', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  // Run the original cashflow_settings creation migration first.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  createSettingsTable = require('../20260603100001-create-cashflow-settings.js');
  await createSettingsTable.up(sequelize.getQueryInterface(), Sequelize);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260606000002-cashflow-settings-exclude-non-partner-inflows.js');
});

after(async () => {
  await sequelize.close();
});

test('up adds exclude_non_partner_inflows BOOLEAN NOT NULL DEFAULT true', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const description = await sequelize.getQueryInterface().describeTable('cashflow_settings');
  const col = description.exclude_non_partner_inflows;
  assert.ok(col, 'exclude_non_partner_inflows column missing');
  assert.equal(col.allowNull, false);
  // SQLite default may be "1" / true depending on driver.
  assert.ok(col.defaultValue === true || col.defaultValue === 1 || col.defaultValue === '1');
});

test('row inserted without exclude_non_partner_inflows defaults to true', async () => {
  await sequelize.query(`INSERT INTO users (id) VALUES (1)`);
  await sequelize.query(`
    INSERT INTO cashflow_settings (user_id, created_at, updated_at)
    VALUES (1, datetime('now'), datetime('now'))
  `);
  const [rows] = await sequelize.query(
    `SELECT exclude_non_partner_inflows FROM cashflow_settings WHERE user_id = 1`,
  );
  const row = (rows as Array<{ exclude_non_partner_inflows: number | boolean }>)[0];
  assert.ok(row.exclude_non_partner_inflows === 1 || row.exclude_non_partner_inflows === true);
});

test('inserting exclude_non_partner_inflows=0 round-trips', async () => {
  await sequelize.query(`INSERT INTO users (id) VALUES (2)`);
  await sequelize.query(`
    INSERT INTO cashflow_settings (user_id, exclude_non_partner_inflows, created_at, updated_at)
    VALUES (2, 0, datetime('now'), datetime('now'))
  `);
  const [rows] = await sequelize.query(
    `SELECT exclude_non_partner_inflows FROM cashflow_settings WHERE user_id = 2`,
  );
  const row = (rows as Array<{ exclude_non_partner_inflows: number | boolean }>)[0];
  assert.ok(row.exclude_non_partner_inflows === 0 || row.exclude_non_partner_inflows === false);
});

test('down drops the exclude_non_partner_inflows column cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const description = await sequelize.getQueryInterface().describeTable('cashflow_settings');
  assert.equal(description.exclude_non_partner_inflows, undefined);
});
