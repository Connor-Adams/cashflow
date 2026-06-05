import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

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
  migration = require('../20260602000001-ai-review-runs.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates ai_review_runs table', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    tables.includes('ai_review_runs'),
    `Expected ai_review_runs in: ${tables.join(', ')}`,
  );
});

test('ai_review_runs has expected columns + NOT NULL flags', async () => {
  const description = await sequelize.getQueryInterface().describeTable('ai_review_runs');
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
  assert.equal(description.model?.allowNull, true);
  assert.equal(description.prompt_version?.allowNull, true);
  assert.equal(description.error_message?.allowNull, true);
});

test('ai_review_runs supports a completed run row with action items JSON', async () => {
  await sequelize.query(`INSERT INTO households (id) VALUES (1)`);
  await sequelize.query(`INSERT INTO users (id) VALUES (1)`);
  await sequelize.query(
    `INSERT INTO ai_review_runs
       (household_id, user_id, period_start, period_end, currency, status,
        summary, action_items, model, prompt_version, error_message,
        created_at, updated_at)
     VALUES
       (1, 1, '2026-05-01', '2026-05-31', 'CAD', 'completed',
        '2 action items', ?, 'deterministic', 'ai-review-v1', NULL,
        datetime('now'), datetime('now'))`,
    {
      replacements: [
        JSON.stringify([
          { id: 'anomaly-1', type: 'anomaly', severity: 'action' },
          { id: 'subscription-Netflix', type: 'subscription', severity: 'info' },
        ]),
      ],
    },
  );
  const [rows] = await sequelize.query(
    `SELECT status, summary, action_items, currency FROM ai_review_runs
     WHERE household_id = 1`,
  );
  const row = (rows as Array<{
    status: string;
    summary: string;
    action_items: string;
    currency: string;
  }>)[0];
  assert.equal(row.status, 'completed');
  assert.equal(row.summary, '2 action items');
  assert.equal(row.currency, 'CAD');
  const items = JSON.parse(row.action_items);
  assert.equal(items.length, 2);
  assert.equal(items[0].type, 'anomaly');
});

test('ai_review_runs supports a failed run row capturing the error', async () => {
  await sequelize.query(
    `INSERT INTO ai_review_runs
       (household_id, user_id, period_start, period_end, currency, status,
        summary, action_items, model, prompt_version, error_message,
        created_at, updated_at)
     VALUES
       (1, 1, '2026-04-01', '2026-04-30', 'CAD', 'failed',
        NULL, ?, 'deterministic', 'ai-review-v1', 'OpenAI 429',
        datetime('now'), datetime('now'))`,
    { replacements: [JSON.stringify([])] },
  );
  const [rows] = await sequelize.query(
    `SELECT status, summary, error_message, action_items
       FROM ai_review_runs WHERE period_start = '2026-04-01'`,
  );
  const row = (rows as Array<{
    status: string;
    summary: string | null;
    error_message: string;
    action_items: string;
  }>)[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.summary, null);
  assert.equal(row.error_message, 'OpenAI 429');
  assert.equal(JSON.parse(row.action_items).length, 0);
});

test('down drops the ai_review_runs table cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    !tables.includes('ai_review_runs'),
    `ai_review_runs should be gone, found: ${tables.join(', ')}`,
  );
});
