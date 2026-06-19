/**
 * Round-trip test for the #639 fold migration: money_leak_dismissals →
 * dismissed Observation (insights). Runs up → assert → down → assert → up on an
 * in-memory SQLite, proving ZERO dismissal loss and JSON snapshot fidelity in
 * both directions.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes, QueryTypes } from 'sequelize';

let sequelize: Sequelize;
type Migration = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  up: (...args: any[]) => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  down: (...args: any[]) => Promise<void>;
};
let createDismissals: Migration;
let createInsights: Migration;
let fold: Migration;

const SEED = [
  {
    household_id: 1,
    leak_type: 'small_subscription',
    identity_key: '42',
    snapshot: { merchant: 'TinyCloud', annual: 47.88 },
    dismissed_by_user_id: 1,
  },
  {
    household_id: 1,
    leak_type: 'duplicate_service',
    identity_key: 'CAD|Streaming',
    snapshot: null,
    dismissed_by_user_id: null,
  },
  {
    household_id: 2,
    // identity_key intentionally contains a pipe — proves the fingerprint
    // split on the FIRST `${leakType}|` boundary survives the round-trip.
    leak_type: 'recurring_fee',
    identity_key: 'account service fee|CAD',
    snapshot: { avgAmount: 4.95, occurrences: 6 },
    dismissed_by_user_id: 2,
  },
];

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('households', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  await qi.createTable('users', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  /* eslint-disable @typescript-eslint/no-require-imports */
  createDismissals = require('../20260602100000-money-leak-dismissals.js');
  createInsights = require('../20260531000001-create-insights.js');
  fold = require('../20260626000001-fold-money-leak-dismissals-into-observations.js');
  /* eslint-enable @typescript-eslint/no-require-imports */

  await createDismissals.up(qi, Sequelize);
  await createInsights.up(qi, Sequelize);

  // Seed households/users referenced by FKs on insights.
  await sequelize.query(`INSERT INTO households (id) VALUES (1), (2)`);
  await sequelize.query(`INSERT INTO users (id) VALUES (1), (2)`);

  // Seed the dismissals to fold.
  const now = new Date();
  await qi.bulkInsert(
    'money_leak_dismissals',
    SEED.map((d) => ({
      household_id: d.household_id,
      leak_type: d.leak_type,
      identity_key: d.identity_key,
      snapshot: d.snapshot == null ? null : JSON.stringify(d.snapshot),
      dismissed_by_user_id: d.dismissed_by_user_id,
      created_at: now,
      updated_at: now,
    })),
  );
});

after(async () => {
  await sequelize.close();
});

test('up: copies every dismissal into a dismissed Observation, then drops table', async () => {
  await fold.up(sequelize.getQueryInterface(), Sequelize);

  // The standalone table is gone.
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    !tables.includes('money_leak_dismissals'),
    `money_leak_dismissals should be dropped, found: ${tables.join(', ')}`,
  );

  // Every dismissal is now a dismissed-leak Observation — ZERO loss.
  const insights = await sequelize.query<{
    household_id: number;
    user_id: number | null;
    type: string;
    status: string;
    entity_type: string;
    fingerprint: string;
    metadata: string | null;
  }>(
    `SELECT household_id, user_id, type, status, entity_type, fingerprint, metadata
     FROM insights WHERE entity_type = 'money_leak'`,
    { type: QueryTypes.SELECT },
  );
  assert.equal(insights.length, SEED.length, 'no dismissal lost');

  for (const seed of SEED) {
    const fp = `${seed.leak_type}|${seed.identity_key}`;
    const row = insights.find((i) => i.fingerprint === fp);
    assert.ok(row, `expected dismissed Observation for ${fp}`);
    assert.equal(row!.status, 'dismissed');
    assert.equal(row!.type, seed.leak_type);
    assert.equal(row!.household_id, seed.household_id);
    assert.equal(row!.user_id, seed.dismissed_by_user_id);
    // JSON snapshot fidelity.
    const parsed = row!.metadata == null ? null : JSON.parse(row!.metadata);
    assert.deepEqual(parsed, seed.snapshot);
  }
});

test('down: recreates the table and copies dismissals back (no loss, JSON intact)', async () => {
  await fold.down(sequelize.getQueryInterface(), Sequelize);

  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    tables.includes('money_leak_dismissals'),
    'money_leak_dismissals should be recreated',
  );

  const rows = await sequelize.query<{
    household_id: number;
    leak_type: string;
    identity_key: string;
    snapshot: string | null;
    dismissed_by_user_id: number | null;
  }>(`SELECT * FROM money_leak_dismissals`, { type: QueryTypes.SELECT });
  assert.equal(rows.length, SEED.length, 'every dismissal restored');

  for (const seed of SEED) {
    const row = rows.find(
      (r) =>
        r.household_id === seed.household_id &&
        r.leak_type === seed.leak_type &&
        r.identity_key === seed.identity_key,
    );
    assert.ok(
      row,
      `expected restored dismissal for ${seed.leak_type}|${seed.identity_key}`,
    );
    assert.equal(row!.dismissed_by_user_id, seed.dismissed_by_user_id);
    const parsed = row!.snapshot == null ? null : JSON.parse(row!.snapshot);
    assert.deepEqual(parsed, seed.snapshot);
  }

  // The folded Observations are removed on rollback (clean down).
  const leftover = await sequelize.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM insights WHERE entity_type = 'money_leak'`,
    { type: QueryTypes.SELECT },
  );
  assert.equal(Number(leftover[0].n), 0, 'no folded Observations left behind');
});

test('up again: round-trip is idempotent and lossless', async () => {
  await fold.up(sequelize.getQueryInterface(), Sequelize);
  const insights = await sequelize.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM insights WHERE entity_type = 'money_leak'`,
    { type: QueryTypes.SELECT },
  );
  assert.equal(Number(insights[0].n), SEED.length, 'second up re-folds all rows');
});
