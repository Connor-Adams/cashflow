import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

/**
 * Round-trip migration test for cfo_briefings (issue #236). Uses sqlite
 * in-memory so it runs as part of the standard backend test suite. The
 * actual migration runs against Postgres in production — sqlite is good
 * enough to confirm the schema and reversibility because the migration
 * only uses portable types (INTEGER, STRING, DATEONLY, TEXT, JSON, DATE).
 */

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('households', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  await qi.createTable('users', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260605000020-create-cfo-briefings.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates cfo_briefings table', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    tables.includes('cfo_briefings'),
    `Expected cfo_briefings in: ${tables.join(', ')}`,
  );
});

test('cfo_briefings has expected columns + NOT NULL flags', async () => {
  const description = await sequelize.getQueryInterface().describeTable('cfo_briefings');
  // Required NOT NULL columns
  assert.equal(description.household_id?.allowNull, false);
  assert.equal(description.user_id?.allowNull, false);
  assert.equal(description.period_start?.allowNull, false);
  assert.equal(description.period_end?.allowNull, false);
  assert.equal(description.currency?.allowNull, false);
  assert.equal(description.status?.allowNull, false);
  assert.equal(description.action_items?.allowNull, false);
  // Nullable columns
  assert.equal(description.summary?.allowNull, true);
  assert.equal(description.safe_to_spend_snapshot?.allowNull, true);
  assert.equal(description.model?.allowNull, true);
  assert.equal(description.prompt_version?.allowNull, true);
  assert.equal(description.error_message?.allowNull, true);
});

test('cfo_briefings supports a completed run row with action items + safeToSpend snapshot', async () => {
  await sequelize.query(`INSERT INTO households (id) VALUES (1)`);
  await sequelize.query(`INSERT INTO users (id) VALUES (1)`);
  await sequelize.query(
    `INSERT INTO cfo_briefings
       (household_id, user_id, period_start, period_end, currency, status,
        summary, action_items, safe_to_spend_snapshot,
        model, prompt_version, error_message,
        created_at, updated_at)
     VALUES
       (1, 1, '2026-05-20', '2026-05-26', 'CAD', 'completed',
        '3 items to review', ?, ?, 'deterministic', 'cfo-briefing-v1', NULL,
        datetime('now'), datetime('now'))`,
    {
      replacements: [
        JSON.stringify([
          { id: 'forecast_warning-1', type: 'forecast_warning', severity: 'watch', status: 'open' },
          { id: 'missing_receipt-42', type: 'missing_receipt', severity: 'watch', status: 'open' },
          { id: 'safe_to_spend_low-snap', type: 'safe_to_spend_low', severity: 'action', status: 'open' },
        ]),
        JSON.stringify({
          value: 245.5,
          currency: 'CAD',
          isNegative: false,
          windowDays: 14,
        }),
      ],
    },
  );
  const [rows] = await sequelize.query(
    `SELECT status, summary, action_items, safe_to_spend_snapshot, currency
       FROM cfo_briefings WHERE household_id = 1`,
  );
  const row = (rows as Array<{
    status: string;
    summary: string;
    action_items: string;
    safe_to_spend_snapshot: string;
    currency: string;
  }>)[0];
  assert.equal(row.status, 'completed');
  assert.equal(row.summary, '3 items to review');
  assert.equal(row.currency, 'CAD');
  const items = JSON.parse(row.action_items);
  assert.equal(items.length, 3);
  assert.equal(items[0].type, 'forecast_warning');
  const snap = JSON.parse(row.safe_to_spend_snapshot);
  assert.equal(snap.value, 245.5);
  assert.equal(snap.currency, 'CAD');
});

test('cfo_briefings supports a failed run capturing the error', async () => {
  await sequelize.query(
    `INSERT INTO cfo_briefings
       (household_id, user_id, period_start, period_end, currency, status,
        summary, action_items, safe_to_spend_snapshot,
        model, prompt_version, error_message,
        created_at, updated_at)
     VALUES
       (1, 1, '2026-05-01', '2026-05-07', 'CAD', 'failed',
        NULL, ?, NULL, 'deterministic', 'cfo-briefing-v1', 'DB timeout',
        datetime('now'), datetime('now'))`,
    { replacements: [JSON.stringify([])] },
  );
  const [rows] = await sequelize.query(
    `SELECT status, summary, error_message, action_items, safe_to_spend_snapshot
       FROM cfo_briefings WHERE period_start = '2026-05-01'`,
  );
  const row = (rows as Array<{
    status: string;
    summary: string | null;
    error_message: string;
    action_items: string;
    safe_to_spend_snapshot: string | null;
  }>)[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.summary, null);
  assert.equal(row.error_message, 'DB timeout');
  assert.equal(JSON.parse(row.action_items).length, 0);
  assert.equal(row.safe_to_spend_snapshot, null);
});

test('down drops the cfo_briefings table cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    !tables.includes('cfo_briefings'),
    `cfo_briefings should be gone, found: ${tables.join(', ')}`,
  );
});
