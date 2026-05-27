'use strict';

/**
 * Saved searches (issue #235 — smart finance search).
 *
 * One row per user-named query string. Distinct from #272 SavedFilter (which
 * stores Transactions-page URL params) — here the column is the entire
 * structured query string the user typed into the search box (e.g.
 * `category:Groceries amount:>100 date:2026-01..03 scope:business has:receipt`).
 *
 * UNIQUE(user_id, name) so the user can't have two saved searches with the
 * same display name. Composite INDEX(user_id) powers the dropdown list query.
 */

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

async function addIndex(queryInterface, table, fields, options) {
  try {
    await queryInterface.addIndex(table, fields, options);
  } catch (e) {
    if (!String(e && e.message).includes('already exists')) throw e;
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('saved_searches', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      name: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      query: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await addIndex(
      queryInterface,
      'saved_searches',
      ['user_id', 'name'],
      { name: 'saved_searches_user_name', unique: true },
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('saved_searches');
  },
};
