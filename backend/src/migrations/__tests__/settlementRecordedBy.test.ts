import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, QueryTypes } from 'sequelize';

const migration = require('../20260618100002-settlement-recorded-by.js');

test('settlement-recorded-by: adds column and backfills owner', async () => {
  const sequelize = new Sequelize('sqlite::memory:', { logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('users', {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
  });
  await qi.createTable('household_members', {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    household_id: 'INTEGER', user_id: 'INTEGER', role: 'VARCHAR(32)',
    created_at: 'DATETIME', updated_at: 'DATETIME',
  });
  await qi.createTable('partner_settlements', {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    household_id: 'INTEGER', contact_id: 'INTEGER', direction: 'VARCHAR(32)',
    currency: 'VARCHAR(3)', amount: 'DECIMAL(14,4)', settled_date: 'DATE',
    created_at: 'DATETIME', updated_at: 'DATETIME',
  });
  await qi.bulkInsert('users', [{ id: 99 }]);
  await qi.bulkInsert('household_members', [
    { household_id: 5, user_id: 99, role: 'owner', created_at: new Date(), updated_at: new Date() },
  ]);
  await qi.bulkInsert('partner_settlements', [
    { household_id: 5, contact_id: 1, direction: 'i_paid_partner', currency: 'CAD', amount: '10.0', settled_date: '2026-05-01', created_at: new Date(), updated_at: new Date() },
  ]);
  await migration.up(qi, Sequelize);
  const rows = await sequelize.query('SELECT recorded_by_user_id FROM partner_settlements', { type: QueryTypes.SELECT });
  assert.equal((rows as Array<{ recorded_by_user_id: number | null }>)[0].recorded_by_user_id, 99);

  // down removes the column; the settlement row itself survives.
  await migration.down(qi, Sequelize);
  const cols = await sequelize.query('PRAGMA table_info(partner_settlements)', { type: QueryTypes.SELECT });
  assert.ok(!(cols as Array<{ name: string }>).some((c) => c.name === 'recorded_by_user_id'));
  const survivors = await sequelize.query('SELECT COUNT(*) AS c FROM partner_settlements', { type: QueryTypes.SELECT });
  assert.equal((survivors as Array<{ c: number }>)[0].c, 1);
  await sequelize.close();
});
