/**
 * Round-trip test for migration
 *   20260609000000-create-feedback
 *
 * Mirrors reimbursementsMigration.test.ts: spin up an in-memory SQLite DB,
 * stub the parent tables the FKs reference (households, users), then run `up`
 * + assert the schema, exercise the CASCADE delete, and run `down` + assert
 * the table is gone (AC#1: migration creates the table with the specified
 * columns + index; reversible).
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
  // Enforce FK constraints so CASCADE behaviour is exercised.
  await sequelize.query('PRAGMA foreign_keys = ON;');
  const qi = sequelize.getQueryInterface();
  await qi.createTable('households', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  await qi.createTable('users', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260609000000-create-feedback.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates feedback with the expected columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    tables.includes('feedback'),
    `Expected feedback in: ${tables.join(', ')}`,
  );
  const cols = await sequelize.getQueryInterface().describeTable('feedback');
  for (const col of [
    'id',
    'household_id',
    'user_id',
    'category',
    'body',
    'current_path',
    'user_agent',
    'app_version',
    'resolved_at',
    'created_at',
    'updated_at',
  ]) {
    assert.ok(col in cols, `Expected column ${col} in feedback`);
  }
});

test('creates the (user_id, created_at) index', async () => {
  const indexes = (await sequelize
    .getQueryInterface()
    .showIndex('feedback')) as Array<{ name: string }>;
  assert.ok(
    indexes.some((i) => i.name === 'feedback_user_id_created_at'),
    `Expected feedback_user_id_created_at among: ${indexes
      .map((i) => i.name)
      .join(', ')}`,
  );
});

test('user_id CASCADE deletes the row with its author', async () => {
  await sequelize.query(`INSERT INTO households (id) VALUES (1)`);
  await sequelize.query(`INSERT INTO users (id) VALUES (1)`);
  await sequelize.query(
    `INSERT INTO feedback
       (household_id, user_id, category, body, created_at, updated_at)
     VALUES (1, 1, 'bug', 'something broke', datetime('now'), datetime('now'))`,
  );
  await sequelize.query(`DELETE FROM users WHERE id = 1`);
  const [rows] = (await sequelize.query(
    `SELECT id FROM feedback WHERE user_id = 1`,
  )) as [{ id: number }[], unknown];
  assert.equal(rows.length, 0, 'cascade should delete feedback for the user');
});

test('down drops the table cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    !tables.includes('feedback'),
    `Table should be gone, found: ${tables.join(', ')}`,
  );
});
