/**
 * Migration round-trip for #259: adds `onboarding_dismissed_at` TIMESTAMP
 * NULL DEFAULT NULL to the `cashflow_settings` table (forward + backward,
 * AC #10).
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
  migration = require('../20260608000005-cashflow-settings-onboarding-dismissed-at.js');
});

after(async () => {
  await sequelize.close();
});

test('up adds onboarding_dismissed_at nullable with NULL default', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const description = await sequelize.getQueryInterface().describeTable('cashflow_settings');
  const col = description.onboarding_dismissed_at;
  assert.ok(col, 'onboarding_dismissed_at column missing');
  assert.equal(col.allowNull, true);
  // Default is NULL — sqlite reports null/undefined for "no default".
  assert.ok(col.defaultValue === null || col.defaultValue === undefined);
});

test('row inserted without onboarding_dismissed_at defaults to NULL', async () => {
  await sequelize.query(`INSERT INTO users (id) VALUES (1)`);
  await sequelize.query(`
    INSERT INTO cashflow_settings (user_id, created_at, updated_at)
    VALUES (1, datetime('now'), datetime('now'))
  `);
  const [rows] = await sequelize.query(
    `SELECT onboarding_dismissed_at FROM cashflow_settings WHERE user_id = 1`,
  );
  const row = (rows as Array<{ onboarding_dismissed_at: string | null }>)[0];
  assert.equal(row.onboarding_dismissed_at, null);
});

test('a timestamp value round-trips', async () => {
  await sequelize.query(`INSERT INTO users (id) VALUES (2)`);
  await sequelize.query(`
    INSERT INTO cashflow_settings (user_id, onboarding_dismissed_at, created_at, updated_at)
    VALUES (2, '2026-05-30 12:00:00', datetime('now'), datetime('now'))
  `);
  const [rows] = await sequelize.query(
    `SELECT onboarding_dismissed_at FROM cashflow_settings WHERE user_id = 2`,
  );
  const row = (rows as Array<{ onboarding_dismissed_at: string | null }>)[0];
  assert.ok(row.onboarding_dismissed_at != null);
  assert.match(String(row.onboarding_dismissed_at), /2026-05-30/);
});

test('down drops the onboarding_dismissed_at column cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const description = await sequelize.getQueryInterface().describeTable('cashflow_settings');
  assert.equal(description.onboarding_dismissed_at, undefined);
});
