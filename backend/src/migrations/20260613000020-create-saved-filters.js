'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('saved_filters', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'users', key: 'id' },
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

    await queryInterface.addIndex('saved_filters', ['user_id', 'page', 'position'], {
      name: 'saved_filters_user_page_pos_idx',
    });

    await queryInterface.addConstraint('saved_filters', {
      fields: ['user_id', 'page', 'name'],
      type: 'unique',
      name: 'saved_filters_user_page_name_uq',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('saved_filters');
  },
};
