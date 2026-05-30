/**
 * Round-trip migration test for the corporate-actions columns added to
 * investment_activities (issue #301): recipient_security_id,
 * cost_basis_allocation_pct, cash_component. Mirrors the in-memory SQLite
 * pattern used by the other migration tests. Fills the gap left when
 * split_ratio shipped without a migration test.
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
  // Minimal pre-existing investment_activities table (only the columns the
  // migration touches need to exist for addColumn/removeColumn).
  await qi.createTable('investment_activities', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    account_id: { type: DataTypes.INTEGER, allowNull: false },
    activity_type: { type: DataTypes.STRING(32), allowNull: false },
    trade_date: { type: DataTypes.DATEONLY, allowNull: false },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../../src/migrations/20260530000001-corporate-actions.js');
});

after(async () => {
  await sequelize.close();
});

test('up adds the three nullable corporate-action columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('investment_activities');
  assert.ok(desc.recipient_security_id, 'recipient_security_id should exist');
  assert.ok(desc.cost_basis_allocation_pct, 'cost_basis_allocation_pct should exist');
  assert.ok(desc.cash_component, 'cash_component should exist');
  assert.equal(desc.recipient_security_id.allowNull, true);
  assert.equal(desc.cost_basis_allocation_pct.allowNull, true);
  assert.equal(desc.cash_component.allowNull, true);
});

test('existing rows are preserved and new columns default to null', async () => {
  await sequelize.query(
    `INSERT INTO investment_activities (account_id, activity_type, trade_date) VALUES (1, 'buy', '2024-01-01')`,
  );
  const [rows] = await sequelize.query(
    `SELECT activity_type, recipient_security_id, cost_basis_allocation_pct, cash_component
       FROM investment_activities WHERE account_id = 1`,
  );
  const row = (rows as Array<Record<string, unknown>>)[0];
  assert.equal(row.activity_type, 'buy');
  assert.equal(row.recipient_security_id, null);
  assert.equal(row.cost_basis_allocation_pct, null);
  assert.equal(row.cash_component, null);
});

test('down removes exactly the three columns', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('investment_activities');
  assert.equal(desc.recipient_security_id, undefined);
  assert.equal(desc.cost_basis_allocation_pct, undefined);
  assert.equal(desc.cash_component, undefined);
  // Untouched columns remain.
  assert.ok(desc.activity_type, 'activity_type should remain');
  assert.ok(desc.trade_date, 'trade_date should remain');
});
