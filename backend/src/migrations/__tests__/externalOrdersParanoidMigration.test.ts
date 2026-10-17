/**
 * Round-trip test for migration 20260911000002-external-orders-paranoid
 * (docs/superpowers/specs/2026-09-11-account-card-identifiers-design.md,
 * Part 5).
 *
 * Mirrors the pattern in transferPurposeMigration.test.ts: spin up an
 * in-memory SQLite DB, stub the parent `external_orders` table with a
 * pre-existing row, run `up` + assert + `down` + assert.
 *
 * Coverage:
 *   - `up` adds a nullable `deleted_at` column.
 *   - Existing rows survive the round-trip without data loss.
 *   - `down` removes the column cleanly (reversible).
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  // Minimal stub of the `external_orders` table the migration touches.
  await sequelize.getQueryInterface().createTable('external_orders', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    vendor: { type: DataTypes.STRING(32), allowNull: false },
  });
  // Seed a row so we can prove the column-add preserves existing data.
  await sequelize.query(`INSERT INTO external_orders (id, vendor) VALUES (1, 'amazon')`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260911000002-external-orders-paranoid.js');
});

after(async () => {
  await sequelize.close();
});

test('up: adds a nullable deleted_at column', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('external_orders');
  assert.ok('deleted_at' in desc, 'deleted_at column missing');
  assert.equal(desc.deleted_at.allowNull, true, 'deleted_at must be nullable');
});

test('up: preserves the existing row and leaves deleted_at NULL', async () => {
  const [rows] = await sequelize.query(
    `SELECT id, vendor, deleted_at FROM external_orders WHERE id = 1`,
  );
  const row = (rows as Array<{ id: number; vendor: string; deleted_at: string | null }>)[0];
  assert.equal(row.id, 1);
  assert.equal(row.vendor, 'amazon');
  assert.equal(row.deleted_at, null);
});

test('down: removes the deleted_at column cleanly (reversible)', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('external_orders');
  assert.ok(!('deleted_at' in desc), 'deleted_at column should be gone after down()');
  // The original row (and column) survive the round-trip.
  const [rows] = await sequelize.query(`SELECT id, vendor FROM external_orders WHERE id = 1`);
  assert.equal((rows as Array<{ id: number }>).length, 1);
});
