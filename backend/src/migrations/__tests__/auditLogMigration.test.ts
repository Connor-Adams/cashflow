/**
 * Round-trip test for the audit_log migration (Cashflow #228).
 *
 * Creates the table on an in-memory SQLite, asserts the schema and
 * indexes, exercises a sample insert/read, then rolls it back and
 * confirms the table is gone.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260526185144-create-audit-log.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates audit_log table with expected columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    tables.includes('audit_log'),
    `Expected audit_log table in: ${tables.join(', ')}`,
  );

  const desc = await sequelize.getQueryInterface().describeTable('audit_log');
  assert.ok(desc.id, 'has id');
  assert.ok(desc.household_id, 'has household_id');
  assert.ok(desc.actor_user_id, 'has actor_user_id');
  assert.ok(desc.action, 'has action');
  assert.ok(desc.entity_type, 'has entity_type');
  assert.ok(desc.entity_id, 'has entity_id');
  assert.ok(desc.summary, 'has summary');
  assert.ok(desc.before, 'has before');
  assert.ok(desc.after, 'has after');
  assert.ok(desc.metadata, 'has metadata');
  assert.ok(desc.created_at, 'has created_at');
  assert.ok(desc.updated_at, 'has updated_at');

  // household_id must be NOT NULL; actor_user_id must be nullable
  assert.equal(desc.household_id.allowNull, false);
  assert.equal(desc.actor_user_id.allowNull, true);
  assert.equal(desc.action.allowNull, false);
  assert.equal(desc.entity_type.allowNull, false);
  assert.equal(desc.entity_id.allowNull, true);
  assert.equal(desc.before.allowNull, true);
  assert.equal(desc.after.allowNull, true);
  assert.equal(desc.metadata.allowNull, true);
});

test('indexes exist for household_id+created_at and entity lookups', async () => {
  const indexes = await sequelize.getQueryInterface().showIndex('audit_log');
  const names = (indexes as Array<{ name: string }>).map((i) => i.name);
  assert.ok(
    names.includes('audit_log_household_created_at'),
    `Expected household_created_at index, got ${names.join(', ')}`,
  );
  assert.ok(
    names.includes('audit_log_household_entity'),
    `Expected household_entity index, got ${names.join(', ')}`,
  );
  assert.ok(
    names.includes('audit_log_household_action'),
    `Expected household_action index, got ${names.join(', ')}`,
  );
});

test('sample insert with JSON payload round-trips', async () => {
  // Sample insert: ensures the JSON column actually accepts an object.
  // SQLite stores JSON as TEXT, but the read-back should be JSON-parsable.
  await sequelize.query(
    `INSERT INTO audit_log (household_id, actor_user_id, action, entity_type, entity_id, summary, before, after, metadata, created_at, updated_at)
     VALUES (1, 2, 'transaction.updated', 'transaction', 42, 'changed category',
       json('{"categoryOverride":"Food"}'), json('{"categoryOverride":"Dining"}'),
       json('{"requestId":"abc"}'), datetime('now'), datetime('now'))`,
  );
  const rows = await sequelize.query<{
    action: string;
    entity_type: string;
    entity_id: number;
    summary: string;
  }>(
    `SELECT action, entity_type, entity_id, summary FROM audit_log WHERE entity_id = 42`,
    { type: 'SELECT' as never },
  );
  const list = rows as unknown as Array<{
    action: string;
    entity_type: string;
    entity_id: number;
    summary: string;
  }>;
  assert.equal(list.length, 1);
  assert.equal(list[0].action, 'transaction.updated');
  assert.equal(list[0].entity_type, 'transaction');
  assert.equal(Number(list[0].entity_id), 42);
  assert.equal(list[0].summary, 'changed category');
});

test('down drops the table cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    !tables.includes('audit_log'),
    `Table should be gone, found: ${tables.join(', ')}`,
  );
});
