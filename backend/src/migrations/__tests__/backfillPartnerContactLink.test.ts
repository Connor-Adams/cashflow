import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, QueryTypes } from 'sequelize';

const migration = require('../20260618100003-backfill-partner-contact-link.js');

async function seed(qi: ReturnType<Sequelize['getQueryInterface']>) {
  await qi.bulkInsert('household_members', [
    { household_id: 1, user_id: 10, role: 'owner', created_at: new Date(), updated_at: new Date() },
    { household_id: 1, user_id: 11, role: 'member', created_at: new Date(), updated_at: new Date() },
    // household 2: two non-owner members -> ambiguous, must be skipped
    { household_id: 2, user_id: 20, role: 'owner', created_at: new Date(), updated_at: new Date() },
    { household_id: 2, user_id: 21, role: 'member', created_at: new Date(), updated_at: new Date() },
    { household_id: 2, user_id: 22, role: 'member', created_at: new Date(), updated_at: new Date() },
  ]);
  await qi.bulkInsert('contacts', [
    { id: 1, household_id: 1, name: 'Alex', is_partner: 1, user_id: null, created_at: new Date(), updated_at: new Date() },
    { id: 2, household_id: 2, name: 'X', is_partner: 1, user_id: null, created_at: new Date(), updated_at: new Date() },
  ]);
}

test('backfill links sole partner-contact to sole non-owner member', async () => {
  const sequelize = new Sequelize('sqlite::memory:', { logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('household_members', {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    household_id: 'INTEGER', user_id: 'INTEGER', role: 'VARCHAR(32)',
    created_at: 'DATETIME', updated_at: 'DATETIME',
  });
  await qi.createTable('contacts', {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    household_id: 'INTEGER', name: 'VARCHAR(160)', is_partner: 'BOOLEAN', user_id: 'INTEGER',
    created_at: 'DATETIME', updated_at: 'DATETIME',
  });
  await seed(qi);
  await migration.up(qi, Sequelize);
  const rows = await sequelize.query('SELECT id, user_id FROM contacts ORDER BY id', { type: QueryTypes.SELECT });
  assert.equal((rows as Array<{ id: number; user_id: number | null }>)[0].user_id, 11);
  assert.equal((rows as Array<{ id: number; user_id: number | null }>)[1].user_id, null); // household 2 ambiguous
  await sequelize.close();
});
