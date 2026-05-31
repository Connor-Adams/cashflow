'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('security_dividends', 'matched_transaction_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: null,
      references: { model: 'transactions', key: 'id' },
      onDelete: 'SET NULL',
    });
    await queryInterface.addColumn('security_dividends', 'matched_at', {
      type: Sequelize.DATE,
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addIndex('security_dividends', ['matched_transaction_id'], {
      name: 'security_dividends_matched_txn_idx',
    });
    await queryInterface.addIndex('security_dividends', ['matched_at'], {
      name: 'security_dividends_matched_at_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('security_dividends', 'security_dividends_matched_at_idx');
    await queryInterface.removeIndex('security_dividends', 'security_dividends_matched_txn_idx');
    await queryInterface.removeColumn('security_dividends', 'matched_at');
    await queryInterface.removeColumn('security_dividends', 'matched_transaction_id');
  },
};
