/**
 * Round-trip test for migration
 *   20260608000010-liability-accounts-cc-fields
 *
 * Credit-card payment planner (#243) extends the existing `liability_accounts`
 * sidecar (#202) with the *operational* bill-management fields it lacks:
 *   - statement_date       DATEONLY — when the current statement closed.
 *   - autopay_enabled      BOOLEAN, default false.
 *   - autopay_type         STRING(16) — full | minimum | fixed.
 *   - autopay_amount       DECIMAL(14,4) — used when autopay_type = 'fixed'.
 *   - payment_account_id   INTEGER FK accounts(id) ON DELETE SET NULL — the
 *                          cash account the bill is paid from.
 *
 * These are *additive* columns on an existing table; the migration must add
 * them on `up` and drop them on `down` without disturbing the columns #202
 * already created (interest_rate, minimum_payment, statement_balance, due_day).
 *
 * In-memory SQLite, stub the parent `accounts` table + a minimal
 * `liability_accounts` table, run up + assert the new columns and their
 * defaults + the payment_account_id SET NULL semantics, then down.
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

const PRE_EXISTING_COLS = [
  'id',
  'account_id',
  'household_id',
  'interest_rate',
  'minimum_payment',
  'statement_balance',
  'due_day',
  'created_at',
  'updated_at',
];

const NEW_COLS = [
  'statement_date',
  'autopay_enabled',
  'autopay_type',
  'autopay_amount',
  'payment_account_id',
];

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  await sequelize.query('PRAGMA foreign_keys = ON;');
  const qi = sequelize.getQueryInterface();

  // Parent table referenced by the new payment_account_id FK.
  await qi.createTable('accounts', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });

  // Minimal stand-in for the #202 liability_accounts table the migration alters.
  await qi.createTable('liability_accounts', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    account_id: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    interest_rate: { type: DataTypes.DECIMAL(7, 4), allowNull: false, defaultValue: 0 },
    minimum_payment: { type: DataTypes.DECIMAL(14, 4), allowNull: false, defaultValue: 0 },
    statement_balance: { type: DataTypes.DECIMAL(14, 4), allowNull: true },
    due_day: { type: DataTypes.INTEGER, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../../src/migrations/20260608000010-liability-accounts-cc-fields.js');
});

after(async () => {
  await sequelize.close();
});

test('up adds the credit-card operational columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const cols = await sequelize.getQueryInterface().describeTable('liability_accounts');
  for (const col of [...PRE_EXISTING_COLS, ...NEW_COLS]) {
    assert.ok(col in cols, `Expected column ${col} in liability_accounts`);
  }
});

test('autopay_enabled defaults to false and is NOT NULL', async () => {
  await sequelize.query(`INSERT INTO accounts (id) VALUES (1)`);
  await sequelize.query(
    `INSERT INTO liability_accounts
       (account_id, household_id, interest_rate, minimum_payment, created_at, updated_at)
     VALUES (1, 1, 0, 0, datetime('now'), datetime('now'))`,
  );
  const [rows] = (await sequelize.query(
    `SELECT autopay_enabled FROM liability_accounts WHERE account_id = 1`,
  )) as [{ autopay_enabled: number | boolean }[], unknown];
  // SQLite stores booleans as 0/1.
  assert.equal(Number(rows[0]?.autopay_enabled), 0);
});

test('statement_date / autopay_type / autopay_amount / payment_account_id are nullable', async () => {
  const [rows] = (await sequelize.query(
    `SELECT statement_date, autopay_type, autopay_amount, payment_account_id
       FROM liability_accounts WHERE account_id = 1`,
  )) as [
    {
      statement_date: string | null;
      autopay_type: string | null;
      autopay_amount: string | null;
      payment_account_id: number | null;
    }[],
    unknown,
  ];
  assert.equal(rows[0]?.statement_date, null);
  assert.equal(rows[0]?.autopay_type, null);
  assert.equal(rows[0]?.autopay_amount, null);
  assert.equal(rows[0]?.payment_account_id, null);
});

test('payment_account_id SET NULL when the referenced account is deleted', async () => {
  await sequelize.query(`INSERT INTO accounts (id) VALUES (2)`);
  await sequelize.query(`INSERT INTO accounts (id) VALUES (3)`);
  await sequelize.query(
    `INSERT INTO liability_accounts
       (account_id, household_id, interest_rate, minimum_payment, payment_account_id, created_at, updated_at)
     VALUES (2, 1, 0, 0, 3, datetime('now'), datetime('now'))`,
  );
  await sequelize.query(`DELETE FROM accounts WHERE id = 3`);
  const [rows] = (await sequelize.query(
    `SELECT payment_account_id FROM liability_accounts WHERE account_id = 2`,
  )) as [{ payment_account_id: number | null }[], unknown];
  assert.equal(rows.length, 1, 'the liability profile must survive its payment account being deleted');
  assert.equal(rows[0]?.payment_account_id, null);
});

test('down removes only the new columns, leaving #202 columns intact', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const cols = await sequelize.getQueryInterface().describeTable('liability_accounts');
  for (const col of NEW_COLS) {
    assert.ok(!(col in cols), `Column ${col} should have been dropped`);
  }
  for (const col of PRE_EXISTING_COLS) {
    assert.ok(col in cols, `Pre-existing column ${col} must remain after down`);
  }
});
