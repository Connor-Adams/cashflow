import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migration = require(path.join(__dirname, '..', '..', 'src', 'migrations', '20260529000002-households-benchmark-symbol.js'));

let sequelize: Sequelize;

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  await sequelize.getQueryInterface().createTable('households', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(160), allowNull: false },
  });
  await sequelize.query(`INSERT INTO households (id, name) VALUES (1, 'Existing')`);
});

after(async () => { await sequelize.close(); });

test('up adds benchmark_symbol column with default SPY', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const [results] = await sequelize.query(`SELECT benchmark_symbol FROM households WHERE id = 1`);
  assert.equal((results as Array<{ benchmark_symbol: string }>)[0].benchmark_symbol, 'SPY');
});

test('down drops the column', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const cols = await sequelize.getQueryInterface().describeTable('households');
  assert.equal(cols.benchmark_symbol, undefined);
});
