import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, QueryTypes } from 'sequelize';

const migration = require('../20260618100001-contact-user-link.js');

test('contact-user-link: adds nullable user_id to contacts', async () => {
  const sequelize = new Sequelize('sqlite::memory:', { logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('contacts', {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    household_id: { type: 'INTEGER', allowNull: false },
    name: { type: 'VARCHAR(160)', allowNull: false },
    created_at: { type: 'DATETIME', allowNull: false },
    updated_at: { type: 'DATETIME', allowNull: false },
  });
  await migration.up(qi, Sequelize);
  const cols = await sequelize.query('PRAGMA table_info(contacts)', {
    type: QueryTypes.SELECT,
  });
  assert.ok((cols as Array<{ name: string }>).some((c) => c.name === 'user_id'));
  await sequelize.close();
});
