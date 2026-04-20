'use strict';

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('receipts', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      transaction_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'transactions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      stored_filename: {
        type: Sequelize.STRING(256),
        allowNull: false,
      },
      original_name: {
        type: Sequelize.STRING(512),
        allowNull: false,
      },
      mime_type: {
        type: Sequelize.STRING(128),
        allowNull: false,
      },
      size_bytes: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      extracted_note: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('receipts', ['transaction_id'], {
      name: 'receipts_transaction_id',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('receipts');
  },
};
