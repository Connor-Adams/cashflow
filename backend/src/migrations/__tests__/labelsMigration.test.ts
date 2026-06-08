import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  // Foreign-key enforcement is off by default in sqlite; turn it on so the
  // ON DELETE CASCADE behaviour (AC #9) is actually exercised.
  await sequelize.query('PRAGMA foreign_keys = ON');
  await qi.createTable('households', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  await qi.createTable('transactions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260609000001-create-labels.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates labels and transaction_labels tables', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(tables.includes('labels'), `Expected labels in: ${tables.join(', ')}`);
  assert.ok(
    tables.includes('transaction_labels'),
    `Expected transaction_labels in: ${tables.join(', ')}`,
  );
});

test('labels has the expected columns', async () => {
  // NOTE: Sequelize's sqlite describeTable() throws on a table carrying a
  // functional index (our LOWER(name) unique index), so introspect columns
  // via PRAGMA table_info instead. `pk` > 0 marks a primary-key column;
  // `notnull` is 1 for NOT NULL.
  const [cols] = (await sequelize.query(`PRAGMA table_info('labels')`)) as [
    Array<{ name: string; notnull: number; pk: number }>,
    unknown,
  ];
  const by = new Map(cols.map((c) => [c.name, c]));
  assert.ok((by.get('id')?.pk ?? 0) > 0, 'id should be the primary key');
  assert.equal(by.get('household_id')?.notnull, 1);
  assert.equal(by.get('name')?.notnull, 1);
  assert.equal(by.get('created_at')?.notnull, 1);
  assert.equal(by.get('updated_at')?.notnull, 1);
});

test('labels enforces the 32-char name limit at the column level', async () => {
  // STRING(32) → VARCHAR(32). sqlite does not enforce VARCHAR length, so this
  // documents the declared type rather than asserting truncation; the route
  // layer is the authoritative gate (AC #3). We assert the column exists and
  // is typed as a bounded varchar in the DDL.
  const [rows] = (await sequelize.query(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='labels'`,
  )) as [Array<{ sql: string }>, unknown];
  assert.match(rows[0].sql, /`name`\s+VARCHAR\(32\)/i);
});

test('transaction_labels has a composite (transaction_id, label_id) primary key', async () => {
  const d = await sequelize.getQueryInterface().describeTable('transaction_labels');
  assert.equal(d.transaction_id?.primaryKey, true);
  assert.equal(d.label_id?.primaryKey, true);
  assert.equal(d.created_at?.allowNull, false);
});

test('transaction_labels has the label-first lookup index', async () => {
  const indexes = await sequelize.getQueryInterface().showIndex('transaction_labels');
  const found = (indexes as Array<{ name: string }>).find(
    (i) => i.name === 'transaction_labels_label_txn',
  );
  assert.ok(found, 'Expected transaction_labels_label_txn index');
});

test('labels rejects two names that differ only by case in the same household', async () => {
  await sequelize.query(`INSERT INTO households (id) VALUES (1)`);
  await sequelize.query(`
    INSERT INTO labels (household_id, name, created_at, updated_at)
    VALUES (1, 'Tax-Deductible', datetime('now'), datetime('now'))
  `);
  let threw = false;
  try {
    await sequelize.query(`
      INSERT INTO labels (household_id, name, created_at, updated_at)
      VALUES (1, 'tax-deductible', datetime('now'), datetime('now'))
    `);
  } catch {
    threw = true;
  }
  assert.equal(threw, true, 'Case-insensitive duplicate within a household should be rejected');
});

test('labels allows the same name in a different household', async () => {
  await sequelize.query(`INSERT INTO households (id) VALUES (2)`);
  await sequelize.query(`
    INSERT INTO labels (household_id, name, created_at, updated_at)
    VALUES (2, 'tax-deductible', datetime('now'), datetime('now'))
  `);
  const [rows] = await sequelize.query(
    `SELECT COUNT(*) AS c FROM labels WHERE name = 'tax-deductible'`,
  );
  assert.equal(Number((rows as Array<{ c: number }>)[0].c), 1);
});

test('deleting a transaction cascades to transaction_labels (AC #9)', async () => {
  await sequelize.query(`INSERT INTO transactions (id) VALUES (100)`);
  const [labelRows] = await sequelize.query(
    `SELECT id FROM labels WHERE household_id = 1 LIMIT 1`,
  );
  const labelId = (labelRows as Array<{ id: number }>)[0].id;
  await sequelize.query(`
    INSERT INTO transaction_labels (transaction_id, label_id, created_at)
    VALUES (100, ${labelId}, datetime('now'))
  `);
  await sequelize.query(`DELETE FROM transactions WHERE id = 100`);
  const [linkRows] = await sequelize.query(
    `SELECT COUNT(*) AS c FROM transaction_labels WHERE transaction_id = 100`,
  );
  assert.equal(
    Number((linkRows as Array<{ c: number }>)[0].c),
    0,
    'transaction_labels rows should be removed when the transaction is deleted',
  );
});

test('deleting a label cascades to transaction_labels', async () => {
  await sequelize.query(`INSERT INTO transactions (id) VALUES (101)`);
  const [labelRows] = await sequelize.query(
    `SELECT id FROM labels WHERE household_id = 1 LIMIT 1`,
  );
  const labelId = (labelRows as Array<{ id: number }>)[0].id;
  await sequelize.query(`
    INSERT INTO transaction_labels (transaction_id, label_id, created_at)
    VALUES (101, ${labelId}, datetime('now'))
  `);
  await sequelize.query(`DELETE FROM labels WHERE id = ${labelId}`);
  const [linkRows] = await sequelize.query(
    `SELECT COUNT(*) AS c FROM transaction_labels WHERE label_id = ${labelId}`,
  );
  assert.equal(Number((linkRows as Array<{ c: number }>)[0].c), 0);
});

test('down drops both tables cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(!tables.includes('labels'), `labels should be gone, found: ${tables.join(', ')}`);
  assert.ok(
    !tables.includes('transaction_labels'),
    `transaction_labels should be gone, found: ${tables.join(', ')}`,
  );
});
