import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: any;

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('tax_entities', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    kind: { type: DataTypes.STRING(16), allowNull: false },
    legal_name: { type: DataTypes.STRING(160), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await qi.createTable('accounts', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING, allowNull: false },
    household_id: { type: DataTypes.INTEGER, allowNull: true },
    entity_id: { type: DataTypes.INTEGER, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await qi.createTable('transactions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    account_id: { type: DataTypes.INTEGER, allowNull: false },
    entity_id: { type: DataTypes.INTEGER, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260618000001-entity-id-foreign-keys.js');
});
after(async () => {
  await sequelize.close();
});

const now = new Date().toISOString();
beforeEach(async () => {
  await sequelize.query('DELETE FROM transactions');
  await sequelize.query('DELETE FROM accounts');
  await sequelize.query('DELETE FROM tax_entities');
});

// The FK DDL is Postgres-only (SQLite cannot ALTER TABLE ADD CONSTRAINT
// without a full table rebuild, which the repo avoids). On the SQLite test
// DB the migration must be a safe no-op — these tests pin that the dialect
// guard is in place (without it, ALTER TABLE ADD CONSTRAINT throws a syntax
// error on SQLite). The real Postgres FK behaviour is exercised by the
// integration suite, which runs the whole migration chain against Postgres.
test('up is a safe no-op on sqlite (FK added on postgres only)', async () => {
  const qi = sequelize.getQueryInterface();
  await qi.bulkInsert('tax_entities', [
    { id: 1, household_id: 1, kind: 'personal', legal_name: 'Personal', created_at: now, updated_at: now },
  ]);
  await qi.bulkInsert('accounts', [
    { id: 5, name: 'A', household_id: 1, entity_id: 1, created_at: now, updated_at: now },
  ]);
  await qi.bulkInsert('transactions', [
    { id: 7, account_id: 5, entity_id: 1, created_at: now, updated_at: now },
  ]);

  await assert.doesNotReject(() => migration.up(qi, Sequelize));

  // No-op on SQLite: data untouched, table still writable.
  const [accts] = await sequelize.query('SELECT entity_id FROM accounts WHERE id = 5');
  assert.equal((accts as { entity_id: number }[])[0].entity_id, 1);
  const [txns] = await sequelize.query('SELECT entity_id FROM transactions WHERE id = 7');
  assert.equal((txns as { entity_id: number }[])[0].entity_id, 1);
});

test('up is idempotent on sqlite (safe to re-run)', async () => {
  const qi = sequelize.getQueryInterface();
  await assert.doesNotReject(() => migration.up(qi, Sequelize));
  await assert.doesNotReject(() => migration.up(qi, Sequelize));
});

test('down is a safe no-op on sqlite', async () => {
  await assert.doesNotReject(() => migration.down(sequelize.getQueryInterface(), Sequelize));
});
