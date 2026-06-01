import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...a: any[]) => Promise<void>; down: (...a: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('contacts', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(160), allowNull: false },
    notes: { type: DataTypes.TEXT, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await sequelize.query(`INSERT INTO contacts (id, household_id, name, notes, created_at, updated_at) VALUES
    (1, 1, 'Jane Doe', NULL, datetime('now'), datetime('now')),
    (2, 1, 'JANE DOE', NULL, datetime('now'), datetime('now')),
    (3, 1, 'Mike Smith', NULL, datetime('now'), datetime('now'))`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../../src/migrations/20260531120000-contacts-normalized-name.js');
});
after(async () => { await sequelize.close(); });

test('up backfills normalized_name and disambiguates per-household collisions', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const [rows] = await sequelize.query(`SELECT id, normalized_name FROM contacts ORDER BY id ASC`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byId = Object.fromEntries((rows as any[]).map((r) => [r.id, r.normalized_name]));
  assert.equal(byId[1], 'jane doe', 'oldest keeps the base key');
  assert.equal(byId[2], 'jane doe#2', 'younger collision disambiguated');
  assert.equal(byId[3], 'mike smith');
});

test('unique index rejects a duplicate (household_id, normalized_name)', async () => {
  await sequelize.query(`INSERT INTO contacts (id, household_id, name, normalized_name, notes, created_at, updated_at)
    VALUES (4, 1, 'Mike Smith 2', 'mike smith', NULL, datetime('now'), datetime('now'))`).then(
    () => assert.fail('expected unique-index violation'),
    () => { /* expected */ },
  );
});

test('down removes the column + index cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('contacts');
  assert.equal(desc.normalized_name, undefined);
});
