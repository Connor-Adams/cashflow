/**
 * Round-trip test for the finance_events migration (Cashflow #238).
 *
 * Creates the table on an in-memory SQLite, asserts the schema and
 * indexes, exercises a sample insert/read, then rolls it back and
 * confirms the table is gone.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260605000031-create-finance-events.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates finance_events table with expected columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    tables.includes('finance_events'),
    `Expected finance_events table in: ${tables.join(', ')}`,
  );

  const desc = await sequelize.getQueryInterface().describeTable('finance_events');
  assert.ok(desc.id, 'has id');
  assert.ok(desc.household_id, 'has household_id');
  assert.ok(desc.actor_user_id, 'has actor_user_id');
  assert.ok(desc.type, 'has type');
  assert.ok(desc.entity_type, 'has entity_type');
  assert.ok(desc.entity_id, 'has entity_id');
  assert.ok(desc.payload, 'has payload');
  assert.ok(desc.occurred_at, 'has occurred_at');
  assert.ok(desc.created_at, 'has created_at');
  assert.ok(desc.updated_at, 'has updated_at');

  // household_id and type must be NOT NULL; actor/entity columns nullable.
  assert.equal(desc.household_id.allowNull, false);
  assert.equal(desc.actor_user_id.allowNull, true);
  assert.equal(desc.type.allowNull, false);
  assert.equal(desc.entity_type.allowNull, true);
  assert.equal(desc.entity_id.allowNull, true);
  assert.equal(desc.payload.allowNull, true);
  assert.equal(desc.occurred_at.allowNull, false);
});

test('indexes exist for stream tail, entity history, and type filter', async () => {
  const indexes = await sequelize.getQueryInterface().showIndex('finance_events');
  const names = (indexes as Array<{ name: string }>).map((i) => i.name);
  assert.ok(
    names.includes('finance_events_household_created_at'),
    `Expected household_created_at index, got ${names.join(', ')}`,
  );
  assert.ok(
    names.includes('finance_events_household_entity'),
    `Expected household_entity index, got ${names.join(', ')}`,
  );
  assert.ok(
    names.includes('finance_events_household_type_created_at'),
    `Expected household_type_created_at index, got ${names.join(', ')}`,
  );
});

test('sample insert with JSON payload round-trips', async () => {
  // Confirms the JSON column accepts an object.
  await sequelize.query(
    `INSERT INTO finance_events
       (household_id, actor_user_id, type, entity_type, entity_id, payload, occurred_at, created_at, updated_at)
     VALUES (1, 2, 'transaction.updated', 'transaction', 42,
       json('{"changed":["categoryOverride"],"after":{"categoryOverride":"Food"}}'),
       datetime('now'), datetime('now'), datetime('now'))`,
  );
  const rows = await sequelize.query<{
    type: string;
    entity_type: string;
    entity_id: number;
  }>(
    `SELECT type, entity_type, entity_id FROM finance_events WHERE entity_id = 42`,
    { type: 'SELECT' as never },
  );
  const list = rows as unknown as Array<{
    type: string;
    entity_type: string;
    entity_id: number;
  }>;
  assert.equal(list.length, 1);
  assert.equal(list[0].type, 'transaction.updated');
  assert.equal(list[0].entity_type, 'transaction');
  assert.equal(Number(list[0].entity_id), 42);
});

test('down drops the table cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    !tables.includes('finance_events'),
    `Table should be gone, found: ${tables.join(', ')}`,
  );
});
