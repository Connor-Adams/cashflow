import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migration = require(path.join(__dirname, '..', '20260529000001-portfolio-daily-snapshots.js'));

let sequelize: Sequelize;

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  await sequelize.getQueryInterface().createTable('households', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  await sequelize.getQueryInterface().createTable('accounts', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
});

after(async () => { await sequelize.close(); });

test('up creates portfolio_daily_snapshots table', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(tables.includes('portfolio_daily_snapshots'));
});

test('enforces UNIQUE (household_id, account_id, date)', async () => {
  await sequelize.query(`INSERT INTO households (id) VALUES (1)`);
  await sequelize.query(`INSERT INTO accounts (id) VALUES (10)`);
  await sequelize.query(`
    INSERT INTO portfolio_daily_snapshots
      (household_id, account_id, date, market_value_native, currency, fx_rate_to_cad,
       market_value_cad, cash_flow_native, cash_flow_cad, is_partial,
       computed_at, created_at, updated_at)
    VALUES (1, 10, '2026-05-15', 1000, 'CAD', 1.0, 1000, 0, 0, 0,
            datetime('now'), datetime('now'), datetime('now'))
  `);
  await assert.rejects(
    sequelize.query(`
      INSERT INTO portfolio_daily_snapshots
        (household_id, account_id, date, market_value_native, currency, fx_rate_to_cad,
         market_value_cad, cash_flow_native, cash_flow_cad, is_partial,
         computed_at, created_at, updated_at)
      VALUES (1, 10, '2026-05-15', 2000, 'CAD', 1.0, 2000, 0, 0, 0,
              datetime('now'), datetime('now'), datetime('now'))
    `),
  );
});

test('down drops table cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(!tables.includes('portfolio_daily_snapshots'));
});
