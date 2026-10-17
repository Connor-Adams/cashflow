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
    normalized_name: { type: DataTypes.STRING(160), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await qi.addIndex('contacts', ['household_id', 'normalized_name'], {
    unique: true,
    name: 'idx_contacts_household_normalized_name',
  });
  // 1,2: renamed in the UI while the hook dropped normalized_name from the UPDATE.
  // 3:   already consistent — must be left alone.
  // 4:   normalized_name leaked extra description text at creation time.
  // 5,6: recomputing collides inside household 1; oldest keeps the base key.
  // 7:   same key as 5/6 but a DIFFERENT household — must NOT be disambiguated.
  // 8:   normalized_name never set.
  await sequelize.query(`INSERT INTO contacts (id, household_id, name, normalized_name, created_at, updated_at) VALUES
    (1, 1, 'Evan Adcock',         'evan',                                              datetime('now'), datetime('now')),
    (2, 1, 'Caelan Iten-McGrath', 'caelan',                                            datetime('now'), datetime('now')),
    (3, 1, 'STEPHEN MASSEUR',     'stephen masseur',                                   datetime('now'), datetime('now')),
    (4, 1, 'Connor Adams RBC',    'connor adams rbc for the amount of $5,000.00 (cad)', datetime('now'), datetime('now')),
    (5, 1, 'Sam  Reed',           'sam reed',                                          datetime('now'), datetime('now')),
    (6, 1, 'SAM REED',            'sam reed#6',                                        datetime('now'), datetime('now')),
    (7, 2, 'Sam Reed',            'stale-other-household',                             datetime('now'), datetime('now')),
    (8, 1, 'Nina Park',           NULL,                                                datetime('now'), datetime('now'))`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260914000001-backfill-contact-normalized-name.js');
});
after(async () => { await sequelize.close(); });

async function keys(): Promise<Record<number, string | null>> {
  const [rows] = await sequelize.query('SELECT id, normalized_name FROM contacts ORDER BY id ASC');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Object.fromEntries((rows as any[]).map((r) => [r.id, r.normalized_name]));
}

test('up recomputes normalized_name from the current name', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const byId = await keys();
  assert.equal(byId[1], 'evan adcock', 'renamed row picks up the full name');
  assert.equal(byId[2], 'caelan iten-mcgrath');
  assert.equal(byId[3], 'stephen masseur', 'already-correct row unchanged');
  assert.equal(byId[4], 'connor adams rbc', 'leaked description text dropped');
  assert.equal(byId[8], 'nina park', 'null key filled in');
});

test('up collapses internal whitespace and disambiguates same-household collisions', async () => {
  const byId = await keys();
  assert.equal(byId[5], 'sam reed', 'oldest id keeps the base key');
  assert.equal(byId[6], 'sam reed#6', 'younger collision keeps a suffixed key');
});

test('up scopes collision detection to the household', async () => {
  const byId = await keys();
  assert.equal(byId[7], 'sam reed', 'other household is free to use the same key');
});

test('up is idempotent', async () => {
  const first = await keys();
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  assert.deepEqual(await keys(), first);
});

test('down is a no-op that leaves the recomputed keys in place', async () => {
  const before_ = await keys();
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  assert.deepEqual(await keys(), before_);
});
