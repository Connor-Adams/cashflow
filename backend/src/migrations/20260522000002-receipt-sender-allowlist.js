'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('receipt_sender_allowlist', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'households', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      email_address: { type: Sequelize.STRING(256), allowNull: false },
      label: { type: Sequelize.STRING(128), allowNull: true },
      vendor_hint: { type: Sequelize.STRING(32), allowNull: true },
      enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex(
      'receipt_sender_allowlist',
      ['household_id', 'email_address'],
      { unique: true, name: 'receipt_sender_allowlist_household_email' },
    );
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      'receipt_sender_allowlist',
      'receipt_sender_allowlist_household_email',
    );
    await queryInterface.dropTable('receipt_sender_allowlist');
  },
};
