import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  await sequelize.getQueryInterface().createTable('households', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  await sequelize.getQueryInterface().createTable('securities', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260528000001-portfolio-forward-projections.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates portfolio_forward_projections table', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(tables.includes('portfolio_forward_projections'), `Expected table in: ${tables.join(', ')}`);
});

test('enforces UNIQUE (household_id, security_id)', async () => {
  await sequelize.query(`INSERT INTO households (id) VALUES (1)`);
  await sequelize.query(`INSERT INTO securities (id) VALUES (10)`);
  await sequelize.query(`
    INSERT INTO portfolio_forward_projections
      (household_id, security_id, qty_basis, annual_dividend_per_share, annual_interest_per_share,
       projected_annual_income_native, currency, cadence_label, next_ex_div_dates, computed_at,
       created_at, updated_at)
    VALUES (1, 10, 100, 0, 0, 0, 'CAD', 'none', '[]', datetime('now'), datetime('now'), datetime('now'))
  `);
  await assert.rejects(
    () =>
      sequelize.query(`
        INSERT INTO portfolio_forward_projections
          (household_id, security_id, qty_basis, annual_dividend_per_share, annual_interest_per_share,
           projected_annual_income_native, currency, cadence_label, next_ex_div_dates, computed_at,
           created_at, updated_at)
        VALUES (1, 10, 200, 0, 0, 0, 'CAD', 'none', '[]', datetime('now'), datetime('now'), datetime('now'))
      `),
    (err: Error) => {
      assert.ok(err instanceof Error, 'Should throw an Error');
      return true;
    },
  );
});

test('down drops the table cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(!tables.includes('portfolio_forward_projections'), `Table should be gone, found: ${tables.join(', ')}`);
});
