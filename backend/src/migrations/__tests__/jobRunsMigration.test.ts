import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  migration = require('../20260604000002-create-job-runs.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates job_runs with expected columns and index', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);

  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(tables.includes('job_runs'), `Expected job_runs in: ${tables.join(', ')}`);

  const description = await sequelize.getQueryInterface().describeTable('job_runs');
  assert.equal(description.id?.allowNull, true);
  assert.equal(description.job_name?.allowNull, false);
  assert.equal(description.started_at?.allowNull, false);
  assert.equal(description.finished_at?.allowNull, true);
  assert.equal(description.status?.allowNull, false);
  assert.equal(description.duration_ms?.allowNull, true);
  assert.equal(description.error_message?.allowNull, true);

  const indexes = await sequelize.getQueryInterface().showIndex('job_runs');
  const names = (indexes as Array<{ name: string }>).map((i) => i.name);
  assert.ok(
    names.includes('job_runs_job_name_started_at'),
    `Expected job_runs_job_name_started_at index, got: ${names.join(', ')}`,
  );
});

test('job_runs supports inserting running and finished rows', async () => {
  await sequelize.query(`
    INSERT INTO job_runs
      (job_name, started_at, finished_at, status, duration_ms, error_message, created_at, updated_at)
    VALUES
      ('dailySnapshot', datetime('now'), NULL, 'running', NULL, NULL, datetime('now'), datetime('now')),
      ('dailySnapshot', datetime('now'), datetime('now'), 'failed', 42, 'boom', datetime('now'), datetime('now'))
  `);
  const [rows] = await sequelize.query(
    `SELECT job_name, status, duration_ms, error_message FROM job_runs ORDER BY id`,
  );
  assert.equal((rows as Array<{ status: string }>).length, 2);
  assert.equal((rows as Array<{ status: string }>)[0].status, 'running');
  assert.equal((rows as Array<{ status: string; error_message: string }>)[1].error_message, 'boom');
});

test('down drops job_runs cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), DataTypes);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(!tables.includes('job_runs'), `job_runs should be gone, found: ${tables.join(', ')}`);
});
