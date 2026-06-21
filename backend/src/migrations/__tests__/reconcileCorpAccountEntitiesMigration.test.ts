import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: any;

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('tax_entities', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    kind: { type: DataTypes.STRING(16), allowNull: false },
    legal_name: { type: DataTypes.STRING(160), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await qi.createTable('accounts', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: true },
    name: { type: DataTypes.STRING, allowNull: false },
    entity_id: { type: DataTypes.INTEGER, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260602000010-reconcile-corp-account-entities.js');
});
after(async () => { await sequelize.close(); });

const now = new Date().toISOString();
beforeEach(async () => {
  await sequelize.query('DELETE FROM accounts');
  await sequelize.query('DELETE FROM tax_entities');
});

test('links WS corp accounts to the corp entity case-insensitively', async () => {
  const qi = sequelize.getQueryInterface();
  await qi.bulkInsert('tax_entities', [
    { id: 1, household_id: 1, kind: 'corp', legal_name: 'CDG LABS INC.', created_at: now, updated_at: now },
    { id: 2, household_id: 1, kind: 'personal', legal_name: 'Personal', created_at: now, updated_at: now },
  ]);
  await qi.bulkInsert('accounts', [
    { id: 13, household_id: 1, name: 'Wealthsimple Corporate Investing', entity_id: 2, created_at: now, updated_at: now },
    { id: 24, household_id: 1, name: 'Wealthsimple Corporate Chequing', entity_id: null, created_at: now, updated_at: now },
    { id: 50, household_id: 1, name: 'Wealthsimple TFSA', entity_id: 2, created_at: now, updated_at: now },
  ]);

  await migration.up(qi, Sequelize);

  const [rows] = await sequelize.query('SELECT id, entity_id FROM accounts ORDER BY id');
  const byId = Object.fromEntries(
    (rows as { id: number; entity_id: number }[]).map((r) => [r.id, r.entity_id]),
  );
  assert.equal(byId[13], 1, 'corp investing → corp entity');
  assert.equal(byId[24], 1, 'corp chequing → corp entity');
  assert.equal(byId[50], 2, 'TFSA untouched (still personal)');
});

test('is idempotent and a no-op when no corp entity exists', async () => {
  const qi = sequelize.getQueryInterface();
  await qi.bulkInsert('tax_entities', [
    { id: 2, household_id: 1, kind: 'personal', legal_name: 'Personal', created_at: now, updated_at: now },
  ]);
  await qi.bulkInsert('accounts', [
    { id: 24, household_id: 1, name: 'Wealthsimple Corporate Chequing', entity_id: null, created_at: now, updated_at: now },
  ]);
  await migration.up(qi, Sequelize); // no corp entity → no change
  let [rows] = await sequelize.query('SELECT entity_id FROM accounts WHERE id = 24');
  assert.equal((rows as { entity_id: number | null }[])[0].entity_id, null);

  // Now add corp entity and run twice; second run changes nothing further.
  await qi.bulkInsert('tax_entities', [
    { id: 1, household_id: 1, kind: 'corp', legal_name: 'CDG LABS INC.', created_at: now, updated_at: now },
  ]);
  await migration.up(qi, Sequelize);
  await migration.up(qi, Sequelize);
  [rows] = await sequelize.query('SELECT entity_id FROM accounts WHERE id = 24');
  assert.equal((rows as { entity_id: number }[])[0].entity_id, 1);
});

test('scopes per household — does not cross corp entities between households', async () => {
  const qi = sequelize.getQueryInterface();
  await qi.bulkInsert('tax_entities', [
    { id: 1, household_id: 1, kind: 'corp', legal_name: 'CDG LABS INC.', created_at: now, updated_at: now },
    { id: 3, household_id: 2, kind: 'corp', legal_name: 'Other Co Inc.', created_at: now, updated_at: now },
  ]);
  await qi.bulkInsert('accounts', [
    { id: 24, household_id: 1, name: 'Wealthsimple Corporate Chequing', entity_id: null, created_at: now, updated_at: now },
    { id: 25, household_id: 2, name: 'WS Save for Business', entity_id: null, created_at: now, updated_at: now },
  ]);
  await migration.up(qi, Sequelize);
  const [rows] = await sequelize.query('SELECT id, entity_id FROM accounts ORDER BY id');
  const byId = Object.fromEntries(
    (rows as { id: number; entity_id: number }[]).map((r) => [r.id, r.entity_id]),
  );
  assert.equal(byId[24], 1);
  assert.equal(byId[25], 3);
});

test('down is a safe no-op', async () => {
  await assert.doesNotReject(() => migration.down(sequelize.getQueryInterface()));
});
