import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

/**
 * 20260619000001-entity-id-not-null is a Postgres-only migration: it swaps the
 * entity_id FK to ON DELETE NO ACTION and adds NOT NULL. On SQLite (the unit
 * test dialect) it MUST be a no-op so the test DB keeps entity_id nullable —
 * the real constraint is proven against Postgres in
 * test/integration/entityIdNotNull.test.ts. These tests guard the dialect guard:
 * if it were removed, `ALTER TABLE ... SET NOT NULL` / `DROP CONSTRAINT` would
 * throw on SQLite and fail here.
 */

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
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await qi.createTable('accounts', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: true },
    name: { type: DataTypes.STRING, allowNull: false },
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
  migration = require('../20260619000001-entity-id-not-null.js');
});

after(async () => {
  await sequelize.close();
});

test('up() is a safe no-op on SQLite and leaves entity_id nullable', async () => {
  const qi = sequelize.getQueryInterface();
  await assert.doesNotReject(() => migration.up(qi));

  const now = new Date().toISOString();
  // entity_id still accepts NULL — the Postgres-only constraint was skipped.
  await assert.doesNotReject(() =>
    sequelize.query(
      `INSERT INTO accounts (household_id, name, entity_id, created_at, updated_at)
       VALUES (1, 'a', NULL, '${now}', '${now}')`,
    ),
  );
  await assert.doesNotReject(() =>
    sequelize.query(
      `INSERT INTO transactions (account_id, entity_id, created_at, updated_at)
       VALUES (1, NULL, '${now}', '${now}')`,
    ),
  );
});

test('down() is a safe no-op on SQLite', async () => {
  await assert.doesNotReject(() => migration.down(sequelize.getQueryInterface()));
});
