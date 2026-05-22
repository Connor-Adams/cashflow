'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('processed_email_messages', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'households', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      provider: { type: Sequelize.STRING(32), allowNull: false },
      message_id: { type: Sequelize.STRING(128), allowNull: false },
      status: { type: Sequelize.STRING(32), allowNull: false },
      parser: { type: Sequelize.STRING(32), allowNull: true },
      external_order_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'external_orders', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      error_message: { type: Sequelize.TEXT, allowNull: true },
      subject: { type: Sequelize.STRING(512), allowNull: true },
      from_addr: { type: Sequelize.STRING(256), allowNull: true },
      scanned_at: { type: Sequelize.DATE, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex(
      'processed_email_messages',
      ['household_id', 'provider', 'message_id'],
      { unique: true, name: 'processed_email_messages_household_provider_msg' },
    );
    await queryInterface.addIndex(
      'processed_email_messages',
      ['household_id', 'scanned_at'],
      { name: 'processed_email_messages_household_scanned' },
    );
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      'processed_email_messages',
      'processed_email_messages_household_scanned',
    );
    await queryInterface.removeIndex(
      'processed_email_messages',
      'processed_email_messages_household_provider_msg',
    );
    await queryInterface.dropTable('processed_email_messages');
  },
};
