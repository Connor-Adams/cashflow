/**
 * Round-trip test for the data_exports migration (Cashflow #302).
 *
 * Creates the table on in-memory SQLite, asserts the schema + indexes,
 * runs a sample insert, and verifies the down migration drops the table.
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
  migration = require('../20260608000001-create-data-exports.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates data_exports table with expected columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    tables.includes('data_exports'),
    `Expected data_exports in: ${tables.join(', ')}`,
  );

  const desc = await sequelize.getQueryInterface().describeTable('data_exports');
  assert.ok(desc.id, 'has id');
  assert.ok(desc.user_id, 'has user_id');
  assert.ok(desc.status, 'has status');
  assert.ok(desc.requested_at, 'has requested_at');
  assert.ok(desc.ready_at, 'has ready_at');
  assert.ok(desc.expires_at, 'has expires_at');
  assert.ok(desc.storage_key, 'has storage_key');
  assert.ok(desc.byte_size, 'has byte_size');
  assert.ok(desc.error_message, 'has error_message');
  assert.ok(desc.created_at, 'has created_at');
  assert.ok(desc.updated_at, 'has updated_at');

  // NOT NULL constraints
  assert.equal(desc.user_id.allowNull, false);
  assert.equal(desc.status.allowNull, false);
  assert.equal(desc.requested_at.allowNull, false);

  // Nullable columns
  assert.equal(desc.ready_at.allowNull, true);
  assert.equal(desc.expires_at.allowNull, true);
  assert.equal(desc.storage_key.allowNull, true);
  assert.equal(desc.byte_size.allowNull, true);
  assert.equal(desc.error_message.allowNull, true);
});

test('indexes are created for user+requested_at and expires_at', async () => {
  const indexes = await sequelize.getQueryInterface().showIndex('data_exports');
  const names = (indexes as Array<{ name: string }>).map((i) => i.name);
  assert.ok(
    names.includes('data_exports_user_requested_at'),
    `Expected data_exports_user_requested_at in: ${names.join(', ')}`,
  );
  assert.ok(
    names.includes('data_exports_expires_at'),
    `Expected data_exports_expires_at in: ${names.join(', ')}`,
  );
});

test('sample insert with queued status round-trips', async () => {
  // SQLite in-memory DB has no users table; disable FK enforcement for
  // the insert (the real migration enforces FKs against Postgres at runtime).
  await sequelize.query(`PRAGMA foreign_keys = OFF`);
  await sequelize.query(
    `INSERT INTO data_exports
       (user_id, status, requested_at, ready_at, expires_at,
        storage_key, byte_size, error_message, created_at, updated_at)
     VALUES
       (42, 'queued', datetime('now'), NULL, NULL,
        NULL, NULL, NULL,
        datetime('now'), datetime('now'))`,
  );
  await sequelize.query(`PRAGMA foreign_keys = ON`);
  const rows = (await sequelize.query(
    `SELECT user_id, status, ready_at, storage_key FROM data_exports WHERE user_id = 42`,
    { type: 'SELECT' as never },
  )) as unknown as Array<{
    user_id: number;
    status: string;
    ready_at: null;
    storage_key: null;
  }>;
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].user_id), 42);
  assert.equal(rows[0].status, 'queued');
  assert.equal(rows[0].ready_at, null);
  assert.equal(rows[0].storage_key, null);
});

test('down drops the table cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    !tables.includes('data_exports'),
    `Table should be gone, found: ${tables.join(', ')}`,
  );
});
