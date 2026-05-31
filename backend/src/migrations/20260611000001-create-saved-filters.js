'use strict';

/**
 * Saved filters for the transactions page (issue #272). Each row is a named
 * filter set that a user saved from the transactions filter toolbar. The
 * filter state is stored as JSONB so the UI can evolve its filter shape
 * without requiring a schema migration.
 *
 * Unique constraint on (user_id, page, name) prevents duplicate names per
 * page per user. Index on (user_id, page, position) backs the ordered list
 * query in GET /api/saved-filters?page=.
 *
 * FK delete semantics:
 *   user_id  CASCADE — saved filters belong to the user; remove them when the
 *            user is removed.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('saved_filters', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
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
      page: {
        type: Sequelize.STRING(32),
        allowNull: false,
      },
      filter_json: {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: {},
      },
      position: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
    });

    await queryInterface.addConstraint('saved_filters', {
      fields: ['user_id', 'page', 'name'],
      type: 'unique',
      name: 'saved_filters_user_id_page_name_unique',
    });

    await queryInterface.addIndex('saved_filters', ['user_id', 'page', 'position'], {
      name: 'saved_filters_user_id_page_position',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('saved_filters');
  },
};
