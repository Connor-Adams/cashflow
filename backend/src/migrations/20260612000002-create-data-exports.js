'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('data_exports', {
      id: { type: Sequelize.BIGINT, autoIncrement: true, primaryKey: true },
      user_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onDelete: 'CASCADE',
      },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'queued' },
      requested_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
      ready_at: { type: Sequelize.DATE, allowNull: true },
      expires_at: { type: Sequelize.DATE, allowNull: true },
      storage_key: { type: Sequelize.STRING(256), allowNull: true },
      byte_size: { type: Sequelize.BIGINT, allowNull: true },
      error_message: { type: Sequelize.TEXT, allowNull: true },
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
    await queryInterface.addIndex('data_exports', ['user_id', 'requested_at'], {
      name: 'data_exports_user_id_requested_at_idx',
    });
    await queryInterface.addIndex('data_exports', ['expires_at'], {
      name: 'data_exports_expires_at_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('data_exports');
  },
};
