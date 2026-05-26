/**
 * Round-trip test for the sync_backups migration (Cashflow #239).
 *
 * Mirrors the audit_log migration test: creates the table on in-memory
 * SQLite, asserts the schema + indexes, runs a sample insert, and
 * verifies the down migration drops the table cleanly.
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
  migration = require('../../src/migrations/20260605000050-create-sync-backups.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates sync_backups table with expected columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    tables.includes('sync_backups'),
    `Expected sync_backups in: ${tables.join(', ')}`,
  );

  const desc = await sequelize.getQueryInterface().describeTable('sync_backups');
  assert.ok(desc.id, 'has id');
  assert.ok(desc.household_id, 'has household_id');
  assert.ok(desc.user_id, 'has user_id');
  assert.ok(desc.kind, 'has kind');
  assert.ok(desc.bundle_version, 'has bundle_version');
  assert.ok(desc.schema_version, 'has schema_version');
  assert.ok(desc.bundle_bytes, 'has bundle_bytes');
  assert.ok(desc.table_counts, 'has table_counts');
  assert.ok(desc.created_at, 'has created_at');
  assert.ok(desc.updated_at, 'has updated_at');

  assert.equal(desc.household_id.allowNull, false);
  // user_id MUST be nullable so a future cloud-sync agent can record
  // a system-driven backup.
  assert.equal(desc.user_id.allowNull, true);
  assert.equal(desc.kind.allowNull, false);
  assert.equal(desc.bundle_version.allowNull, false);
  assert.equal(desc.schema_version.allowNull, false);
  assert.equal(desc.bundle_bytes.allowNull, false);
  assert.equal(desc.table_counts.allowNull, false);
});

test('indexes exist for household timeline and kind filtering', async () => {
  const indexes = await sequelize.getQueryInterface().showIndex('sync_backups');
  const names = (indexes as Array<{ name: string }>).map((i) => i.name);
  assert.ok(
    names.includes('sync_backups_household_created_at'),
    `Expected sync_backups_household_created_at in: ${names.join(', ')}`,
  );
  assert.ok(
    names.includes('sync_backups_household_kind'),
    `Expected sync_backups_household_kind in: ${names.join(', ')}`,
  );
});

test('sample insert with table_counts JSON round-trips', async () => {
  await sequelize.query(
    `INSERT INTO sync_backups
       (household_id, user_id, kind, bundle_version, schema_version,
        bundle_bytes, table_counts, created_at, updated_at)
     VALUES
       (1, 2, 'backup', 1, 1, 4096,
        json('{"transactions":42,"accounts":3}'),
        datetime('now'), datetime('now'))`,
  );
  const rows = (await sequelize.query(
    `SELECT household_id, kind, bundle_bytes, table_counts FROM sync_backups WHERE household_id = 1`,
    { type: 'SELECT' as never },
  )) as unknown as Array<{
    household_id: number;
    kind: string;
    bundle_bytes: number;
    table_counts: string;
  }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'backup');
  assert.equal(Number(rows[0].bundle_bytes), 4096);
  const counts = JSON.parse(rows[0].table_counts);
  assert.deepEqual(counts, { transactions: 42, accounts: 3 });
});

test('down drops the table cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    !tables.includes('sync_backups'),
    `Table should be gone, found: ${tables.join(', ')}`,
  );
});
