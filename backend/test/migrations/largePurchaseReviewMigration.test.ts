/**
 * Round-trip tests for migrations:
 *   20260607100001-cashflow-settings-large-purchase-threshold
 *   20260607100002-create-transaction-large-purchase-reviews
 *
 * Each migration is tested independently against an in-memory SQLite DB.
 * Mirrors the pattern in cashflowSettingsCounterpartyThresholdMigration.test.ts
 * and transactionReturnMetadataMigration.test.ts.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

// ============================================================================
// Migration 1: cashflow-settings-large-purchase-threshold
// ============================================================================

let seqSettings: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let settingsMigration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  seqSettings = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  // Stub parent table with minimum required columns.
  await seqSettings.getQueryInterface().createTable('cashflow_settings', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    minimum_cash_buffer: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: false,
      defaultValue: 0,
    },
    safe_to_spend_window_days: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 14,
    },
    include_credit_card_balance: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    include_goal_contributions: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  });
  // Seed a row so default-fill can be verified post-up().
  await seqSettings.query(
    `INSERT INTO cashflow_settings
       (user_id, minimum_cash_buffer, safe_to_spend_window_days,
        include_credit_card_balance, include_goal_contributions)
     VALUES (1, 0, 14, 1, 1)`,
  );
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  settingsMigration = require('../../src/migrations/20260607100001-cashflow-settings-large-purchase-threshold.js');
});

after(async () => {
  await seqSettings.close();
});

test('settings up: adds large_purchase_threshold column NOT NULL + default 500', async () => {
  await settingsMigration.up(seqSettings.getQueryInterface(), Sequelize);
  const desc = await seqSettings.getQueryInterface().describeTable('cashflow_settings');
  assert.ok('large_purchase_threshold' in desc, 'large_purchase_threshold missing');
  assert.equal(desc.large_purchase_threshold.allowNull, false, 'must be NOT NULL');
});

test('settings up: pre-existing rows get default value 500', async () => {
  const [rows] = (await seqSettings.query(
    `SELECT user_id, large_purchase_threshold FROM cashflow_settings`,
  )) as [Array<{ user_id: number; large_purchase_threshold: string }>, unknown];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, 1);
  // SQLite may return as integer or decimal string — numeric compare is safer.
  assert.equal(Number(rows[0].large_purchase_threshold), 500);
});

test('settings: large_purchase_threshold accepts custom value 0 (disabled)', async () => {
  await seqSettings.query(
    `UPDATE cashflow_settings SET large_purchase_threshold = 0 WHERE user_id = 1`,
  );
  const [rows] = (await seqSettings.query(
    `SELECT large_purchase_threshold FROM cashflow_settings WHERE user_id = 1`,
  )) as [Array<{ large_purchase_threshold: string }>, unknown];
  assert.equal(Number(rows[0].large_purchase_threshold), 0);
});

test('settings down: removes the column cleanly', async () => {
  // Reset before removing.
  await seqSettings.query(
    `UPDATE cashflow_settings SET large_purchase_threshold = 500 WHERE user_id = 1`,
  );
  await settingsMigration.down(seqSettings.getQueryInterface(), Sequelize);
  const desc = await seqSettings.getQueryInterface().describeTable('cashflow_settings');
  assert.ok(
    !('large_purchase_threshold' in desc),
    'large_purchase_threshold should be removed after down()',
  );
});

test('settings down: untouched columns survive', async () => {
  const [rows] = (await seqSettings.query(
    `SELECT user_id, safe_to_spend_window_days FROM cashflow_settings`,
  )) as [Array<{ user_id: number; safe_to_spend_window_days: number }>, unknown];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, 1);
  assert.equal(rows[0].safe_to_spend_window_days, 14);
});

// ============================================================================
// Migration 2: create-transaction-large-purchase-reviews
// ============================================================================

let seqReview: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let reviewMigration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  seqReview = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  // Stub parent table so the FK reference resolves.
  await seqReview.getQueryInterface().createTable('transactions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  reviewMigration = require('../../src/migrations/20260607100002-create-transaction-large-purchase-reviews.js');
});

after(async () => {
  await seqReview.close();
});

test('review up: creates transaction_large_purchase_reviews with expected columns', async () => {
  await reviewMigration.up(seqReview.getQueryInterface(), Sequelize);
  const tables = await seqReview.getQueryInterface().showAllTables();
  assert.ok(
    tables.includes('transaction_large_purchase_reviews'),
    `Expected table in: ${tables.join(', ')}`,
  );
  const cols = await seqReview
    .getQueryInterface()
    .describeTable('transaction_large_purchase_reviews');
  assert.ok('transaction_id' in cols, 'transaction_id missing');
  assert.ok('status' in cols, 'status missing');
  assert.ok('category_confirmed' in cols, 'category_confirmed missing');
  assert.ok('business_relevant' in cols, 'business_relevant missing');
  assert.ok('receipt_confirmed' in cols, 'receipt_confirmed missing');
  assert.ok('warranty_tracked' in cols, 'warranty_tracked missing');
  assert.ok('reimbursement_tracked' in cols, 'reimbursement_tracked missing');
  assert.ok('notes' in cols, 'notes missing');
  assert.ok('reviewed_at' in cols, 'reviewed_at missing');
  assert.ok('created_at' in cols, 'created_at missing');
  assert.ok('updated_at' in cols, 'updated_at missing');
});

test('review: 1:1 mapping enforced by transaction_id PK', async () => {
  await seqReview.query(`INSERT INTO transactions (id) VALUES (1)`);
  await seqReview.query(
    `INSERT INTO transaction_large_purchase_reviews
       (transaction_id, status, created_at, updated_at)
     VALUES (1, 'pending', datetime('now'), datetime('now'))`,
  );
  await assert.rejects(
    () =>
      seqReview.query(
        `INSERT INTO transaction_large_purchase_reviews
           (transaction_id, status, created_at, updated_at)
         VALUES (1, 'reviewed', datetime('now'), datetime('now'))`,
      ),
    (err: Error) => err instanceof Error,
  );
});

test('review: default status is "pending"', async () => {
  await seqReview.query(`INSERT INTO transactions (id) VALUES (2)`);
  await seqReview.query(
    `INSERT INTO transaction_large_purchase_reviews
       (transaction_id, created_at, updated_at)
     VALUES (2, datetime('now'), datetime('now'))`,
  );
  const [rows] = (await seqReview.query(
    `SELECT status FROM transaction_large_purchase_reviews WHERE transaction_id = 2`,
  )) as [{ status: string }[], unknown];
  assert.equal(rows[0]?.status, 'pending');
});

test('review down: drops the table cleanly', async () => {
  await reviewMigration.down(seqReview.getQueryInterface(), Sequelize);
  const tables = await seqReview.getQueryInterface().showAllTables();
  assert.ok(
    !tables.includes('transaction_large_purchase_reviews'),
    `Table should be gone, found: ${tables.join(', ')}`,
  );
});
