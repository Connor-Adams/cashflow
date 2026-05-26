/**
 * Round-trip test for the vault_documents migration (Cashflow issue #241).
 *
 * Creates the table on an in-memory SQLite, asserts the expected columns +
 * indexes, exercises a sample insert with a JSON tags array, then rolls
 * the migration back and confirms the table is gone.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  // Bootstrap minimal FK targets so the migration's references resolve on SQLite.
  const qi = sequelize.getQueryInterface();
  await qi.createTable('households', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(64), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await qi.createTable('users', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    email: { type: DataTypes.STRING(255), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../../src/migrations/20260605000050-create-vault-documents.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates vault_documents table with expected columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    tables.includes('vault_documents'),
    `Expected vault_documents in: ${tables.join(', ')}`,
  );
  const desc = await sequelize.getQueryInterface().describeTable('vault_documents');
  assert.ok(desc.id, 'has id');
  assert.ok(desc.household_id, 'has household_id');
  assert.ok(desc.uploaded_by_user_id, 'has uploaded_by_user_id');
  assert.ok(desc.visibility, 'has visibility');
  assert.ok(desc.original_name, 'has original_name');
  assert.ok(desc.mime_type, 'has mime_type');
  assert.ok(desc.size_bytes, 'has size_bytes');
  assert.ok(desc.stored_filename, 'has stored_filename');
  assert.ok(desc.storage_kind, 'has storage_kind');
  assert.ok(desc.encryption_algorithm, 'has encryption_algorithm');
  assert.ok(desc.encryption_key_version, 'has encryption_key_version');
  assert.ok(desc.tags, 'has tags');
  assert.ok(desc.linked_entity_type, 'has linked_entity_type');
  assert.ok(desc.linked_entity_id, 'has linked_entity_id');
  assert.ok(desc.description, 'has description');
  assert.ok(desc.created_at, 'has created_at');
  assert.ok(desc.updated_at, 'has updated_at');

  assert.equal(desc.household_id.allowNull, false);
  assert.equal(desc.original_name.allowNull, false);
  assert.equal(desc.mime_type.allowNull, false);
  assert.equal(desc.size_bytes.allowNull, false);
  assert.equal(desc.stored_filename.allowNull, false);
  assert.equal(desc.visibility.allowNull, false);
  assert.equal(desc.storage_kind.allowNull, false);
  assert.equal(desc.encryption_algorithm.allowNull, false);
  assert.equal(desc.encryption_key_version.allowNull, false);
  assert.equal(desc.uploaded_by_user_id.allowNull, true);
  assert.equal(desc.tags.allowNull, true);
  assert.equal(desc.linked_entity_type.allowNull, true);
  assert.equal(desc.linked_entity_id.allowNull, true);
  assert.equal(desc.description.allowNull, true);
});

test('indexes exist for household scoping and linked-entity lookup', async () => {
  const indexes = await sequelize.getQueryInterface().showIndex('vault_documents');
  const names = (indexes as Array<{ name: string }>).map((i) => i.name);
  assert.ok(
    names.includes('vault_documents_household_id'),
    `Expected vault_documents_household_id index, got ${names.join(', ')}`,
  );
  assert.ok(
    names.includes('vault_documents_household_entity'),
    `Expected vault_documents_household_entity index, got ${names.join(', ')}`,
  );
  assert.ok(
    names.includes('vault_documents_household_uploader'),
    `Expected vault_documents_household_uploader index, got ${names.join(', ')}`,
  );
});

test('sample insert with JSON tags round-trips', async () => {
  // Seed a household + user so the FK references hold.
  await sequelize.query(
    `INSERT INTO households (id, name, created_at, updated_at) VALUES (1, 'h1', datetime('now'), datetime('now'))`,
  );
  await sequelize.query(
    `INSERT INTO users (id, email, created_at, updated_at) VALUES (1, 'a@b.com', datetime('now'), datetime('now'))`,
  );
  await sequelize.query(
    `INSERT INTO vault_documents (
       household_id, uploaded_by_user_id, visibility, original_name, mime_type, size_bytes,
       stored_filename, storage_kind, encryption_algorithm, encryption_key_version,
       tags, linked_entity_type, linked_entity_id, description, created_at, updated_at
     ) VALUES (
       1, 1, 'shared', 'Invoice.pdf', 'application/pdf', 12345,
       'abcd-1234.pdf', 'local', 'aes-256-gcm', 1,
       json('["tax-2024","invoice"]'), 'transaction', 99, NULL,
       datetime('now'), datetime('now')
     )`,
  );
  const rows = (await sequelize.query(
    `SELECT original_name, encryption_algorithm, tags FROM vault_documents WHERE household_id = 1`,
    { type: 'SELECT' as never },
  )) as unknown as Array<{
    original_name: string;
    encryption_algorithm: string;
    tags: string;
  }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].original_name, 'Invoice.pdf');
  assert.equal(rows[0].encryption_algorithm, 'aes-256-gcm');
  // SQLite returns JSON columns as text — parse to verify the round-trip.
  const tags = JSON.parse(rows[0].tags) as string[];
  assert.deepEqual(tags, ['tax-2024', 'invoice']);
});

test('down drops the table cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    !tables.includes('vault_documents'),
    `Table should be gone, found: ${tables.join(', ')}`,
  );
});
