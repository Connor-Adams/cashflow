import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migration = require(
  path.join(__dirname, '..', '..', 'src', 'migrations', '20260531000001-create-insights.js'),
);

let sequelize: Sequelize;

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  // Stub the dependency tables so the FK targets exist
  await sequelize.getQueryInterface().createTable('households', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(160), allowNull: false },
  });
  await sequelize.getQueryInterface().createTable('users', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    email: { type: DataTypes.STRING(255), allowNull: false },
  });
});

after(async () => {
  await sequelize.close();
});

test('up creates insights table with the documented columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const cols = await sequelize.getQueryInterface().describeTable('insights');
  assert.ok(cols.id, 'expected id column');
  assert.ok(cols.household_id);
  assert.ok(cols.user_id);
  assert.ok(cols.type);
  assert.ok(cols.severity);
  assert.ok(cols.title);
  assert.ok(cols.description);
  assert.ok(cols.entity_type);
  assert.ok(cols.entity_id);
  assert.ok(cols.status);
  assert.ok(cols.fingerprint);
  assert.ok(cols.metadata);
  assert.ok(cols.detected_at);
  assert.ok(cols.created_at);
  assert.ok(cols.updated_at);

  // Sanity: severity defaults to 'info', status defaults to 'open'
  // (the application enforces the literal value sets; here we only confirm the columns exist).
});

test('up creates the unique (household_id, type, fingerprint) index', async () => {
  const indexes = await sequelize.getQueryInterface().showIndex('insights') as Array<{
    name: string;
    unique: boolean;
    fields: Array<{ attribute: string }>;
  }>;
  const dedupe = indexes.find((i) => i.name === 'insights_household_type_fingerprint');
  assert.ok(dedupe, 'expected unique dedupe index');
  assert.equal(dedupe!.unique, true);
});

test('down drops the table', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  await assert.rejects(async () => {
    await sequelize.getQueryInterface().describeTable('insights');
  });
});
