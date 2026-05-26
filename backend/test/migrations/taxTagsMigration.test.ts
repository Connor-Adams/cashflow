/**
 * Round-trip test for migrations 20260601000002-tax-tags and
 * 20260601000003-transaction-tax-metadata. Mirrors the pattern in
 * portfolioForwardProjections.test.ts: spin up an in-memory SQLite DB, stub
 * the parent tables, run up + assert + down.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let taxTagsMigration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let metadataMigration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  // Stub the parent tables the migrations reference (transactions, households).
  await sequelize.getQueryInterface().createTable('households', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  await sequelize.getQueryInterface().createTable('transactions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  taxTagsMigration = require('../../src/migrations/20260601000002-tax-tags.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  metadataMigration = require('../../src/migrations/20260601000003-transaction-tax-metadata.js');
});

after(async () => {
  await sequelize.close();
});

test('tax_tags up creates table with household scope', async () => {
  await taxTagsMigration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(tables.includes('tax_tags'), `Expected tax_tags in: ${tables.join(', ')}`);
});

test('tax_tags enforces UNIQUE (household_id, name)', async () => {
  await sequelize.query(`INSERT INTO households (id) VALUES (1)`);
  await sequelize.query(
    `INSERT INTO tax_tags (household_id, name, description, created_at, updated_at)
     VALUES (1, 'Office', 'Office expenses', datetime('now'), datetime('now'))`,
  );
  await assert.rejects(
    () =>
      sequelize.query(
        `INSERT INTO tax_tags (household_id, name, description, created_at, updated_at)
         VALUES (1, 'Office', 'Duplicate', datetime('now'), datetime('now'))`,
      ),
    (err: Error) => err instanceof Error,
  );
  // Same name in a different household is fine.
  await sequelize.query(`INSERT INTO households (id) VALUES (2)`);
  await sequelize.query(
    `INSERT INTO tax_tags (household_id, name, description, created_at, updated_at)
     VALUES (2, 'Office', NULL, datetime('now'), datetime('now'))`,
  );
});

test('transaction_tax_metadata up creates table with FKs', async () => {
  await metadataMigration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    tables.includes('transaction_tax_metadata'),
    `Expected transaction_tax_metadata in: ${tables.join(', ')}`,
  );
});

test('transaction_tax_metadata enforces 1:1 with transactions (PK)', async () => {
  await sequelize.query(`INSERT INTO transactions (id) VALUES (10)`);
  await sequelize.query(
    `INSERT INTO transaction_tax_metadata
       (transaction_id, tax_tag_id, deductible_percent, hst_gst_amount,
        receipt_required, reviewed_for_tax, created_at, updated_at)
     VALUES (10, NULL, 1, NULL, 0, 0, datetime('now'), datetime('now'))`,
  );
  await assert.rejects(
    () =>
      sequelize.query(
        `INSERT INTO transaction_tax_metadata
           (transaction_id, tax_tag_id, deductible_percent, hst_gst_amount,
            receipt_required, reviewed_for_tax, created_at, updated_at)
         VALUES (10, NULL, 0.5, NULL, 0, 0, datetime('now'), datetime('now'))`,
      ),
    (err: Error) => err instanceof Error,
  );
});

test('transaction_tax_metadata down drops table cleanly', async () => {
  await metadataMigration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    !tables.includes('transaction_tax_metadata'),
    `Table should be gone, found: ${tables.join(', ')}`,
  );
});

test('tax_tags down drops table cleanly', async () => {
  await taxTagsMigration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    !tables.includes('tax_tags'),
    `Table should be gone, found: ${tables.join(', ')}`,
  );
});
