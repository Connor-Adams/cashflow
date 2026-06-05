import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
let migration: {
  up: (qi: ReturnType<Sequelize['getQueryInterface']>, S: typeof Sequelize) => Promise<void>;
  down: (qi: ReturnType<Sequelize['getQueryInterface']>) => Promise<void>;
};

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  await sequelize.getQueryInterface().createTable('users', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    email: { type: DataTypes.STRING(320), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  migration = require('../20260610000001-users-last-seen-changelog-version.js');
});

after(async () => {
  await sequelize.close();
});

test('up: adds nullable last_seen_changelog_version column', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('users');
  assert.ok('last_seen_changelog_version' in desc, 'column missing');
  assert.equal(desc.last_seen_changelog_version.allowNull, true);
  assert.equal(desc.last_seen_changelog_version.defaultValue, null);
});

test('down: removes the column', async () => {
  await migration.down(sequelize.getQueryInterface());
  const desc = await sequelize.getQueryInterface().describeTable('users');
  assert.ok(!('last_seen_changelog_version' in desc), 'column should be gone');
});

test('up again is idempotent (round-trip and no-throw)', async () => {
  // Column was removed by the prior down test; re-running up should re-add it.
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('users');
  assert.ok('last_seen_changelog_version' in desc, 'column should re-appear after second up');
  // Column already exists; calling up again must not throw (guard is a no-op).
  await assert.doesNotReject(
    () => migration.up(sequelize.getQueryInterface(), Sequelize),
    'up() must not throw when column already exists',
  );
});
