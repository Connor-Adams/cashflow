import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...a: any[]) => Promise<void>; down: (...a: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  await sequelize.getQueryInterface().createTable('planned_events', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    price_change_detected: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260614000001-drop-planned-events-price-change-detected.js');
});

after(async () => { await sequelize.close(); });

test('up removes price_change_detected, down re-adds it', async () => {
  const qi = sequelize.getQueryInterface();
  await migration.up(qi, Sequelize);
  let cols = await qi.describeTable('planned_events');
  assert.equal(cols.price_change_detected, undefined);
  await migration.down(qi, Sequelize);
  cols = await qi.describeTable('planned_events');
  assert.ok(cols.price_change_detected);
});

/**
 * Realistic-fixture regression guard.
 *
 * The minimal fixture above cannot see this migration's real failure mode.
 * Sequelize 6 has no native DROP COLUMN path for SQLite, so
 * `queryInterface.removeColumn` rebuilds the table from `describeTable()`
 * output, and that round-trip is lossy three ways: it drops every index, it
 * loses AUTOINCREMENT and every FK action, and it re-reports a COMPOSITE unique
 * index as a per-COLUMN `UNIQUE` flag.
 *
 * On the real `planned_events` the last one is the killer: the partial unique
 * `(household_id, normalized_name, currency)` comes back as `household_id
 * INTEGER UNIQUE`, `currency VARCHAR(3) UNIQUE` and `normalized_name
 * VARCHAR(255) UNIQUE` — one planned event per household ever, and one per
 * currency in the entire table. Verified, not theoretical.
 *
 * So this fixture mirrors the real table's shape: AUTOINCREMENT pk, FKs with
 * actions, plain indexes, and the composite partial unique. A revert of the
 * `dropColumn` fix fails both tests below.
 */
const IDX = [
  'planned_events_account_id',
  'planned_events_household_expected_date',
  'planned_events_subscription_identity_unique',
  'planned_events_user_id',
];

async function seedRealisticPlannedEvents(db: Sequelize) {
  // Real tables for the FK targets: Sequelize turns on `PRAGMA foreign_keys`,
  // so SQLite enforces these and a dangling reference would fail the inserts.
  await db.query('CREATE TABLE `households` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `name` VARCHAR(255))');
  await db.query('CREATE TABLE `users` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `email` VARCHAR(255))');
  await db.query('CREATE TABLE `accounts` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `name` VARCHAR(255))');
  await db.query("INSERT INTO `households` (`name`) VALUES ('H1'), ('H2')");
  await db.query("INSERT INTO `users` (`email`) VALUES ('a@example.com')");
  await db.query("INSERT INTO `accounts` (`name`) VALUES ('Chequing')");

  // Raw DDL, not `createTable`: the point of this fixture is the exact shape
  // `describeTable` cannot round-trip, which `createTable` would not reproduce.
  await db.query(
    'CREATE TABLE `planned_events` (' +
      '`id` INTEGER PRIMARY KEY AUTOINCREMENT, ' +
      '`user_id` INTEGER NOT NULL REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE, ' +
      '`household_id` INTEGER NOT NULL REFERENCES `households` (`id`) ON DELETE CASCADE ON UPDATE CASCADE, ' +
      '`account_id` INTEGER REFERENCES `accounts` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, ' +
      '`name` VARCHAR(255) NOT NULL, ' +
      '`amount` DECIMAL(14,4) NOT NULL, ' +
      '`currency` VARCHAR(3) NOT NULL, ' +
      '`expected_date` DATE NOT NULL, ' +
      "`kind` VARCHAR(16) NOT NULL DEFAULT 'planned', " +
      '`normalized_name` VARCHAR(255), ' +
      '`price_change_detected` TINYINT(1) NOT NULL DEFAULT 0)',
  );
  await db.query('CREATE INDEX `planned_events_user_id` ON `planned_events` (`user_id`)');
  await db.query('CREATE INDEX `planned_events_account_id` ON `planned_events` (`account_id`)');
  await db.query(
    'CREATE INDEX `planned_events_household_expected_date` ON `planned_events` (`household_id`, `expected_date`)',
  );
  await db.query(
    'CREATE UNIQUE INDEX `planned_events_subscription_identity_unique` ' +
      'ON `planned_events` (`household_id`, `normalized_name`, `currency`) ' +
      "WHERE `kind` = 'subscription'",
  );
  // Two subscriptions in the SAME household sharing a currency — legal under the
  // composite unique, rejected the moment `currency` becomes column-level UNIQUE.
  await db.query(
    'INSERT INTO `planned_events` ' +
      '(`user_id`, `household_id`, `account_id`, `name`, `amount`, `currency`, `expected_date`, `kind`, `normalized_name`) VALUES ' +
      "(1, 1, 1, 'Netflix', 20.99, 'CAD', '2026-07-01', 'subscription', 'netflix'), " +
      "(1, 1, 1, 'Spotify', 11.99, 'CAD', '2026-07-02', 'subscription', 'spotify')",
  );
}

async function indexNames(db: Sequelize): Promise<string[]> {
  const [rows] = await db.query(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'planned_events' AND sql IS NOT NULL ORDER BY name",
  );
  return (rows as { name: string }[]).map((r) => r.name);
}

async function plannedEventsDdl(db: Sequelize): Promise<string> {
  const [rows] = await db.query(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'planned_events'",
  );
  return (rows as { sql: string }[])[0].sql;
}

function assertShapeIntact(ddl: string) {
  // The composite unique must NOT have been smeared onto its member columns.
  assert.ok(!/`household_id`[^,]*UNIQUE/i.test(ddl), 'household_id must not be column-level UNIQUE');
  assert.ok(!/`currency`[^,]*UNIQUE/i.test(ddl), 'currency must not be column-level UNIQUE');
  assert.ok(!/`normalized_name`[^,]*UNIQUE/i.test(ddl), 'normalized_name must not be column-level UNIQUE');
  assert.ok(/AUTOINCREMENT/i.test(ddl), 'primary key must keep AUTOINCREMENT');
  assert.ok(/ON DELETE CASCADE/i.test(ddl), 'FK actions must survive');
  assert.ok(/ON DELETE SET NULL/i.test(ddl), 'FK actions must survive');
}

test('up preserves every other index and never makes household_id or currency unique', async () => {
  const db = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  try {
    await seedRealisticPlannedEvents(db);
    await migration.up(db.getQueryInterface(), Sequelize);

    assert.deepEqual(await indexNames(db), IDX);
    const ddl = await plannedEventsDdl(db);
    assert.ok(!/price_change_detected/.test(ddl), 'the column being dropped must be gone');
    assertShapeIntact(ddl);

    // Behavioural proof: a third subscription in household 1, same currency again.
    await db.query(
      'INSERT INTO `planned_events` ' +
        '(`user_id`, `household_id`, `account_id`, `name`, `amount`, `currency`, `expected_date`, `kind`, `normalized_name`) VALUES ' +
        "(1, 1, 1, 'Disney+', 13.99, 'CAD', '2026-07-03', 'subscription', 'disney')",
    );
    const [rows] = await db.query(
      "SELECT COUNT(*) AS n FROM `planned_events` WHERE `household_id` = 1 AND `currency` = 'CAD'",
    );
    assert.equal(Number((rows as { n: number }[])[0].n), 3);
  } finally {
    await db.close();
  }
});

test('down re-adds the column without flattening the schema either', async () => {
  const db = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  try {
    await seedRealisticPlannedEvents(db);
    const qi = db.getQueryInterface();
    await migration.up(qi, Sequelize);
    await migration.down(qi, Sequelize);

    assert.deepEqual(await indexNames(db), IDX);
    const ddl = await plannedEventsDdl(db);
    assert.ok(/price_change_detected/.test(ddl), 'down must restore the column');
    assertShapeIntact(ddl);

    const [rows] = await db.query(
      'SELECT `name`, `price_change_detected` AS pcd FROM `planned_events` ORDER BY `id`',
    );
    assert.deepEqual(rows, [
      { name: 'Netflix', pcd: 0 },
      { name: 'Spotify', pcd: 0 },
    ]);
  } finally {
    await db.close();
  }
});
